import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, waitForPageReady } from './_helpers';

cli({
  site: 'generic',
  name: 'screenshot',
  access: 'read',
  description:
    '打开任意网页并对当前视口截图（PNG，base64 dataUrl）。完成后关闭标签页。等加载稳定后再截图（默认检测 innerText 连续 quiet_ms 不变；可传 wait_for_selector 等特定元素出现）。注意：通过 chrome.debugger 抓取，标签页存在期间会有黄色"正在调试"提示条',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: '要截图的页面 URL（http/https）',
    },
    {
      name: 'max_wait_ms',
      type: 'int',
      help: '加载等待总时长上限（毫秒）。默认 15000',
    },
    {
      name: 'quiet_ms',
      type: 'int',
      help: 'innerText 稳定阈值（毫秒）。默认 1000（截图比读文本对"完全渲染"要求更高）',
    },
    {
      name: 'wait_for_selector',
      type: 'string',
      help: '可选：等到这个 CSS 选择器匹配就截图（短路稳定性检测）',
    },
    {
      name: 'full_page',
      type: 'bool',
      help: '是否截整页（非仅可视区域）。默认 false',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const maxWaitMs = Number(kwargs.max_wait_ms ?? 15_000);
    const quietMs = Number(kwargs.quiet_ms ?? 1000);
    const waitForSelector =
      typeof kwargs.wait_for_selector === 'string' ? kwargs.wait_for_selector : undefined;
    const fullPage = !!kwargs.full_page;

    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') throw new Error('failed to open tab');
    const tabId = tab.id;
    const target: chrome.debugger.Debuggee = { tabId };
    let attached = false;
    try {
      const ready = await waitForPageReady(tabId, { maxWaitMs, quietMs, waitForSelector });
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      const params = fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' };
      const res = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params)) as
        | { data?: string }
        | undefined;
      const data = res?.data ?? '';
      if (!data) throw new Error('Page.captureScreenshot returned no data');
      return {
        dataUrl: `data:image/png;base64,${data}`,
        bytes: data.length,
        url,
        full_page: fullPage,
        wait: ready,
      };
    } finally {
      if (attached) {
        try {
          await chrome.debugger.detach(target);
        } catch {}
      }
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  },
});
