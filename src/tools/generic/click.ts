import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';

cli({
  site: 'generic',
  name: 'click',
  access: 'read',
  description:
    '在一个已打开标签页上点击一个元素。优先用 `get_interactives` 返回的 ref（最稳）；退而求其次也可以传 CSS selector。点击后可选 wait_ms（默认 0 不等）—— 如果点击会触发导航或 SPA 路由切换，建议传 wait_ms: 1500 或之后再调一次 get_interactives 拿新页面状态',
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
      help: 'get_interactives 返回的元素 ref。和 selector 二选一',
    },
    {
      name: 'selector',
      type: 'string',
      help: 'CSS 选择器，当你确定 ref 没的时候用。和 ref 二选一',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: '点击后等待毫秒数（让页面响应 / 导航开始）。默认 0',
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
    const waitMs = Math.max(0, Math.min(30_000, Number(kwargs.wait_ms ?? 0)));
    const selector = ref ? `[data-webchat-ref="${ref}"]` : selectorArg!;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickInPage,
      args: [selector],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    if (!r.found) {
      throw new Error(
        `Element not found for ${ref ? `ref=${ref}` : `selector="${selectorArg}"`}. ` +
          `If you used a ref from an earlier get_interactives call, the page may have re-rendered — call get_interactives again to get fresh refs.`,
      );
    }
    if (waitMs > 0) await sleep(waitMs);
    return { tabId, ...r };
  },
});

function clickInPage(selector: string): {
  found: boolean;
  text?: string;
  tag?: string;
  href?: string;
} {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return { found: false };
  el.scrollIntoView({ behavior: 'auto', block: 'center' });
  el.focus?.();
  el.click();
  return {
    found: true,
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    tag: el.tagName.toLowerCase(),
    href: (el as HTMLAnchorElement).href || undefined,
  };
}
