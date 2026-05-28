import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, waitForPageReady } from './_helpers';

const MAX_TEXT_BYTES = 100_000;

cli({
  site: 'generic',
  name: 'get_page_text',
  access: 'read',
  description:
    '打开任意网页，等加载稳定后抓取标题 + 正文纯文本（document.body.innerText，截断到 100KB）。抓完关闭标签页。比固定 wait_ms 更智能：检测 innerText 长度连续 quiet_ms 内不变就视为加载完成；也可传 wait_for_selector 让目标元素一出现就抓取',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: '要抓取的页面 URL（http/https）',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      help: '加载等待总时长上限（毫秒）。默认 15000',
    },
    {
      name: 'quiet_ms',
      type: 'int',
      help: 'innerText 长度保持不变多久视为稳定（毫秒）。默认 800',
    },
    {
      name: 'wait_for_selector',
      type: 'string',
      help: '可选：等到这个 CSS 选择器匹配到元素就立刻抓取（短路稳定性检测）',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const maxWaitMs = Number(kwargs.max_wait_ms ?? 15_000);
    const quietMs = Number(kwargs.quiet_ms ?? 800);
    const waitForSelector =
      typeof kwargs.wait_for_selector === 'string' ? kwargs.wait_for_selector : undefined;

    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') throw new Error('failed to open tab');
    const tabId = tab.id;
    try {
      const ready = await waitForPageReady(tabId, { maxWaitMs, quietMs, waitForSelector });
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
      return {
        ...r,
        wait: ready,
      };
    } finally {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  },
});
