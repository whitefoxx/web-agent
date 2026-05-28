import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, sleep, waitForTabComplete } from './_helpers';

const MAX_TEXT_BYTES = 100_000;

cli({
  site: 'generic',
  name: 'get_page_text',
  access: 'read',
  description:
    '打开任意网页，等待加载完成后抓取标题 + 正文纯文本（不渲染 markdown，是 document.body.innerText 的截断版）。抓完关闭标签页',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: '要抓取的页面 URL（http/https）',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: '加载完成后再额外等多少毫秒（处理懒加载 / SPA hydration）。默认 1500',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const waitMs = Math.max(0, Math.min(15_000, Number(kwargs.wait_ms ?? 1500)));
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') throw new Error('failed to open tab');
    const tabId = tab.id;
    try {
      await waitForTabComplete(tabId, 30_000);
      if (waitMs > 0) await sleep(waitMs);
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxBytes: number) => ({
          title: document.title,
          url: location.href,
          text: (document.body?.innerText ?? '').slice(0, maxBytes),
        }),
        args: [MAX_TEXT_BYTES],
      });
      const r = results[0]?.result;
      if (!r) throw new Error('executeScript returned no result');
      return r;
    } finally {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  },
});
