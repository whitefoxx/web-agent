import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

/** Cap on items returned per category — keeps the chatbot's prompt size
 * sane on dense pages (a Twitter feed has hundreds of clickable elements
 * but the chatbot only needs the top of the viewport). */
const MAX_PER_CATEGORY = 60;

cli({
  site: 'generic',
  name: 'get_interactives',
  access: 'read',
  description:
    '扫描一个已打开标签页上所有可见、可交互的元素（链接 / 按钮 / 输入框 / 下拉框 / 富文本编辑区），按类别返回结构化列表。每个元素分到一个临时 ref ID（写入 DOM 的 `data-webchat-ref` 属性），后续可在 `click` / `type_into` 工具里用这个 ref 精确定位。**没有 adapter 的网站做导航 / 表单填写 / 点击操作前先调这个**。返回的 ref 在页面下次重大变动（导航 / SPA 路由切换 / 大批 DOM 重渲染）后可能失效；不确定时重新调用一次即可',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '目标 tab id（通常来自 open_url）',
    },
    {
      name: 'max_per_category',
      type: 'int',
      help: `每个类别最多返回多少个（默认 ${MAX_PER_CATEGORY}）。dense 页面可调小到 20-30 节省 token`,
    },
    {
      name: 'only_in_viewport',
      type: 'bool',
      help: '是否只返回当前视口内可见的元素（默认 false，返回所有 display 可见的）。配合 scroll_page 可以分批扫描',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const cap = Math.max(5, Math.min(200, Number(kwargs.max_per_category ?? MAX_PER_CATEGORY)));
    const onlyInViewport = !!kwargs.only_in_viewport;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectInteractives,
      args: [cap, onlyInViewport],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    return {
      tabId,
      url: tab.url ?? '',
      title: tab.title ?? '',
      ...r,
    };
  },
});

/** Runs in the page context. Stays self-contained (no imports). */
function collectInteractives(maxPerCategory: number, onlyInViewport: boolean) {
  const ATTR = 'data-webchat-ref';
  let counter = 0;
  const nextRef = () => `r${(++counter).toString(36)}`;

  // Strip any stale refs from a previous call so the new ref numbering is
  // fresh and old refs don't keep referring to detached / replaced nodes.
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  function isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (onlyInViewport) {
      if (r.bottom < 0 || r.top > vpH || r.right < 0 || r.left > vpW) return false;
    } else {
      // Allow off-screen, just reject totally collapsed elements.
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function tag(el: Element): string {
    const ref = nextRef();
    el.setAttribute(ATTR, ref);
    return ref;
  }

  function trimText(s: string | null | undefined, max = 80): string {
    return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function findLabel(el: Element): string {
    // <label for="id">
    const id = (el as HTMLElement).id;
    if (id) {
      const escaped = id.replace(/(["\\])/g, '\\$1');
      const lbl = document.querySelector(`label[for="${escaped}"]`);
      if (lbl) return trimText(lbl.textContent);
    }
    // Wrapping <label>...
    const wrap = el.closest('label');
    if (wrap) {
      // Strip child's own text so we don't double-count.
      const cloned = wrap.cloneNode(true) as HTMLElement;
      cloned.querySelectorAll('input, textarea, select').forEach((n) => n.remove());
      return trimText(cloned.textContent);
    }
    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target) return trimText(target.textContent);
    }
    return '';
  }

  const seen = new WeakSet<Element>();
  const buttons: Array<{ ref: string; text: string; tag: string; aria?: string }> = [];
  const links: Array<{ ref: string; text: string; href: string }> = [];
  const inputs: Array<{
    ref: string;
    type: string;
    label: string;
    placeholder?: string;
    value?: string;
    required?: boolean;
  }> = [];
  const selects: Array<{
    ref: string;
    label: string;
    options: Array<{ value: string; text: string }>;
  }> = [];
  const editable: Array<{ ref: string; label: string }> = [];

  // BUTTONS (real <button>, role=button, submit/button inputs).
  document
    .querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')
    .forEach((el) => {
      if (buttons.length >= maxPerCategory) return;
      if (seen.has(el) || !isVisible(el)) return;
      seen.add(el);
      const aria = el.getAttribute('aria-label') ?? undefined;
      const text =
        trimText(el.textContent) ||
        trimText(aria) ||
        trimText((el as HTMLInputElement).value) ||
        trimText(el.getAttribute('title'));
      if (!text) return;
      buttons.push({ ref: tag(el), text, tag: el.tagName.toLowerCase(), aria });
    });

  // LINKS (only those with href that look navigable).
  document.querySelectorAll('a[href]').forEach((el) => {
    if (links.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const text = trimText(el.textContent) || trimText(el.getAttribute('aria-label'));
    if (!text) return;
    const href = (el as HTMLAnchorElement).href;
    if (!href || href.startsWith('javascript:')) return;
    links.push({ ref: tag(el), text, href });
  });

  // INPUTS (text-ish) + TEXTAREA.
  document.querySelectorAll('input, textarea').forEach((el) => {
    if (inputs.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    const tag0 = el.tagName.toLowerCase();
    const type =
      tag0 === 'textarea' ? 'textarea' : ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return;
    seen.add(el);
    const label =
      findLabel(el) ||
      trimText(el.getAttribute('aria-label')) ||
      trimText((el as HTMLInputElement).placeholder) ||
      trimText((el as HTMLInputElement).name);
    inputs.push({
      ref: tag(el),
      type,
      label,
      placeholder: (el as HTMLInputElement).placeholder || undefined,
      value: (el as HTMLInputElement).value
        ? trimText((el as HTMLInputElement).value, 60)
        : undefined,
      required: (el as HTMLInputElement).required || undefined,
    });
  });

  // SELECTS.
  document.querySelectorAll('select').forEach((el) => {
    if (selects.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    const opts = Array.from((el as HTMLSelectElement).options)
      .slice(0, 50)
      .map((o) => ({ value: o.value, text: trimText(o.textContent, 60) }));
    selects.push({
      ref: tag(el),
      label: findLabel(el) || trimText(el.getAttribute('name')),
      options: opts,
    });
  });

  // CONTENTEDITABLE — many comment / chat / rich-text inputs use this.
  document.querySelectorAll('[contenteditable=""], [contenteditable="true"]').forEach((el) => {
    if (editable.length >= maxPerCategory) return;
    if (seen.has(el) || !isVisible(el)) return;
    seen.add(el);
    editable.push({
      ref: tag(el),
      label:
        trimText(el.getAttribute('aria-label')) ||
        trimText(el.getAttribute('data-placeholder')) ||
        trimText(el.getAttribute('placeholder')) ||
        '',
    });
  });

  return {
    counts: {
      buttons: buttons.length,
      links: links.length,
      inputs: inputs.length,
      selects: selects.length,
      editable: editable.length,
    },
    buttons,
    links,
    inputs,
    selects,
    editable,
  };
}
