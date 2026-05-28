import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';

cli({
  site: 'generic',
  name: 'type_into',
  access: 'read',
  description:
    '往一个输入框 / textarea / 富文本编辑区里输入文字。优先用 ref（来自 get_interactives，最稳），也支持 CSS selector。默认 replace 原有内容；append=true 时追加。submit=true 时输入完按 Enter（适合搜索框 / 单行输入；多行 textarea 慎用 —— 可能只是换行）',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '目标 tab id',
    },
    {
      name: 'ref',
      type: 'string',
      help: 'get_interactives 返回的 input/textarea/editable 元素 ref。和 selector 二选一',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS 选择器（如 `input[name="q"]`）。和 ref 二选一',
    },
    {
      name: 'text',
      type: 'string',
      required: true,
      help: '要输入的文字',
    },
    {
      name: 'append',
      type: 'bool',
      help: '是否追加而非替换原内容。默认 false（替换）',
    },
    {
      name: 'submit',
      type: 'bool',
      help: '输入完是否按 Enter 提交。默认 false。对单行 input 通常 = 触发表单提交；对 textarea / contenteditable 通常 = 换行（除非站点把 Enter 绑成发送，比如聊天框）',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: '输入完等待毫秒数。submit=true 时建议给个 wait_ms 让请求飞起来。默认 0',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const ref = typeof kwargs.ref === 'string' ? kwargs.ref : null;
    const selectorArg = typeof kwargs.selector === 'string' ? kwargs.selector : null;
    if (!ref && !selectorArg) {
      throw new Error('Must provide either ref (from get_interactives) or selector (CSS).');
    }
    const text = String(kwargs.text ?? '');
    const append = !!kwargs.append;
    const submit = !!kwargs.submit;
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    const selector = ref ? `[data-webchat-ref="${ref}"]` : selectorArg!;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: typeIntoInPage,
      args: [selector, text, append, submit],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found) {
      throw new Error(
        `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
          `Re-run get_interactives if the page has changed.`,
      );
    }
    if (!r.typed) {
      throw new Error(
        `Element found but not typeable (kind="${r.kind}"). type_into supports input / textarea / contenteditable.`,
      );
    }
    if (waitMs > 0) await sleep(waitMs);
    return { tabId, ...r };
  },
});

function typeIntoInPage(
  selector: string,
  text: string,
  append: boolean,
  submit: boolean,
): {
  found: boolean;
  typed?: boolean;
  kind?: string;
  final_value?: string;
  submit_attempted?: boolean;
} {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { found: false };
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  (el as HTMLElement).focus?.();

  const tag = el.tagName.toLowerCase();
  let typed = false;
  let kind = tag;

  if (tag === 'input' || tag === 'textarea') {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    kind =
      tag === 'textarea'
        ? 'textarea'
        : `input[type=${(inputEl as HTMLInputElement).type || 'text'}]`;
    const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const newValue = append ? (inputEl.value ?? '') + text : text;
    if (setter) setter.call(inputEl, newValue);
    else inputEl.value = newValue;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    typed = true;
  } else if (el.isContentEditable) {
    kind = 'contenteditable';
    if (!append) {
      // Select-all + delete by Range API (execCommand is deprecated but
      // still works on contenteditable in Chrome; we fall back to it for
      // any sites that listen specifically for execCommand events).
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      try {
        document.execCommand('delete');
      } catch {
        el.textContent = '';
      }
    } else {
      // Move caret to end before inserting.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    try {
      document.execCommand('insertText', false, text);
    } catch {
      el.textContent = (el.textContent ?? '') + text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    typed = true;
  }

  let submitAttempted = false;
  if (typed && submit) {
    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    const keypress = new KeyboardEvent('keypress', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    const keyup = new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(keydown);
    el.dispatchEvent(keypress);
    el.dispatchEvent(keyup);
    // Also try requestSubmit on parent form (some sites listen there, not on Enter key).
    const form = (el as HTMLInputElement).form;
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
      } catch {}
    }
    submitAttempted = true;
  }

  let finalValue = '';
  if (tag === 'input' || tag === 'textarea') {
    finalValue = ((el as HTMLInputElement).value ?? '').slice(0, 200);
  } else if (el.isContentEditable) {
    finalValue = (el.innerText ?? '').slice(0, 200);
  }

  return {
    found: true,
    typed,
    kind,
    final_value: finalValue,
    submit_attempted: submitAttempted,
  };
}
