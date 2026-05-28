import { cli } from '../../runtime/registry.js';
import { assertTabId, waitForPageReady } from './_helpers';

const MAX_TEXT_BYTES = 100_000;

cli({
  site: 'generic',
  name: 'get_text_from_tab',
  access: 'read',
  description:
    '从一个**已打开的**标签页抓取文本（不会关闭这个 tab，方便后续 scroll_page / get_text_from_tab 再来一次）。可选传 selector 只抓某个元素的文字。常和 open_url + scroll_page 组合使用获取 feed 流加载完更多内容后的文本',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '目标 tab id（通常来自 open_url 的返回值）',
    },
    {
      name: 'selector',
      type: 'string',
      help: '可选 CSS 选择器，只抓取该元素内的 innerText；不传则抓整页 body.innerText',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      help: '在抓取前再等待页面稳定多久（毫秒）。默认 3000（已有 tab 不需要等很久）',
    },
    {
      name: 'quiet_ms',
      type: 'int',
      help: 'innerText 长度连续不变多久视为稳定。默认 600',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const selector = typeof kwargs.selector === 'string' ? kwargs.selector : undefined;
    const maxWaitMs = Math.max(500, Math.min(30_000, Number(kwargs.max_wait_ms ?? 3000)));
    const quietMs = Math.max(100, Math.min(5000, Number(kwargs.quiet_ms ?? 600)));

    // Quick stability check — page may have just been scrolled and is still
    // loading lazy content. Don't be greedy with maxWait; the caller already
    // explicitly opened this tab and we trust them to know the page state.
    const wait = await waitForPageReady(tabId, { maxWaitMs, quietMs });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string | null, maxBytes: number) => {
        const text = sel
          ? ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? '')
          : (document.body?.innerText ?? '');
        return {
          title: document.title,
          url: location.href,
          text: text.slice(0, maxBytes),
          truncated: text.length > maxBytes,
          full_length: text.length,
        };
      },
      args: [selector ?? null, MAX_TEXT_BYTES],
    });
    const r = results[0]?.result;
    if (!r) throw new Error('executeScript returned no result');
    return { ...r, tabId, wait };
  },
});
