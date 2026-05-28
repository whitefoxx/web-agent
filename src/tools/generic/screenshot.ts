import { cli } from '../../runtime/registry.js';
import { assertHttpUrl, sleep, waitForTabComplete } from './_helpers';

cli({
  site: 'generic',
  name: 'screenshot',
  access: 'read',
  description:
    '打开任意网页并对当前视口截图（PNG，base64 dataUrl）。完成后关闭标签页。注意：通过 chrome.debugger 抓取，会在标签页顶部出现黄色"正在调试"提示条直到关闭',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: '要截图的页面 URL（http/https）',
    },
    {
      name: 'wait_ms',
      type: 'int',
      help: '加载完成后再额外等多少毫秒。默认 2000（截图前给页面更多时间渲染）',
    },
    {
      name: 'full_page',
      type: 'bool',
      help: '是否截整页（非仅可视区域）。默认 false',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const waitMs = Math.max(0, Math.min(15_000, Number(kwargs.wait_ms ?? 2000)));
    const fullPage = !!kwargs.full_page;
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') throw new Error('failed to open tab');
    const tabId = tab.id;
    const target: chrome.debugger.Debuggee = { tabId };
    let attached = false;
    try {
      await waitForTabComplete(tabId, 30_000);
      if (waitMs > 0) await sleep(waitMs);
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
