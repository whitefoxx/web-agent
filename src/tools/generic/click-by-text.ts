import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';

cli({
  site: 'generic',
  name: 'click_by_text',
  access: 'read',
  description:
    '不依赖 ref / selector，直接点击页面上**含有指定可见文字**的按钮 / 链接 / role=button 元素。在没有调过 get_interactives 的情况下做"点登录"、"点提交"、"点 New chat"这种语义清晰的点击最方便。匹配策略：先 exact match，没有再 substring；命中多个时点第一个并把候选数报回来。如果有歧义，建议先 get_interactives 看一眼再用 ref',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '目标 tab id',
    },
    {
      name: 'text',
      type: 'string',
      required: true,
      help: '要点击的元素显示文字（区分大小写）',
    },
    {
      name: 'role',
      type: 'string',
      help: '限定元素类型：button | link | any（默认 any —— button / role=button / 链接都搜）',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: '点击后等待毫秒数。默认 0',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const text = String(kwargs.text ?? '').trim();
    if (!text) throw new Error('text is required and must be non-empty');
    const role = String(kwargs.role ?? 'any').toLowerCase();
    if (!['any', 'button', 'link'].includes(role)) {
      throw new Error(`role must be one of: any / button / link; got "${role}"`);
    }
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickByTextInPage,
      args: [text, role],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found) {
      throw new Error(
        `No visible ${role === 'any' ? 'clickable element' : role} with text "${text}" found. ` +
          `Try get_interactives to see what's actually on the page.`,
      );
    }
    if (waitMs > 0) await sleep(waitMs);
    return { tabId, ...r };
  },
});

function clickByTextInPage(
  text: string,
  role: string,
): { found: boolean; matched_text?: string; candidates_count?: number; href?: string } {
  let sel: string;
  if (role === 'button')
    sel = 'button, [role="button"], input[type="submit"], input[type="button"]';
  else if (role === 'link') sel = 'a[href]';
  else sel = 'button, [role="button"], input[type="submit"], input[type="button"], a[href]';

  function isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  const all = Array.from(document.querySelectorAll(sel)).filter(isVisible);
  // Exact match first.
  let candidates = all.filter((el) => {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t === text) return true;
    const v = (el as HTMLInputElement).value;
    if (v && v === text) return true;
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim() === text) return true;
    return false;
  });
  // Fall back to substring.
  if (candidates.length === 0) {
    candidates = all.filter((el) => {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.includes(text)) return true;
      const aria = el.getAttribute('aria-label');
      if (aria && aria.includes(text)) return true;
      return false;
    });
  }
  if (candidates.length === 0) return { found: false };
  const el = candidates[0] as HTMLElement;
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus?.();
  el.click();
  return {
    found: true,
    matched_text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    candidates_count: candidates.length,
    href: (el as HTMLAnchorElement).href || undefined,
  };
}
