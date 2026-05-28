import { cli } from '../../runtime/registry.js';
import { assertTabId, sleep } from './_helpers';

cli({
  site: 'generic',
  name: 'scroll_page',
  access: 'read',
  description:
    '在一个**已打开的**标签页上模拟人类滚动（每次滚动一个视口高度的 70%-100% 随机量，每次间隔有抖动）。常用于触发懒加载 / 无限滚动 feed 来加载更多内容。配合 `open_url` 拿到的 tab_id 使用',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '目标 tab 的 id（通常来自 open_url 的返回值；切勿瞎填）',
    },
    {
      name: 'times',
      type: 'int',
      help: '滚动次数。默认 3，上限 30',
    },
    {
      name: 'direction',
      type: 'string',
      help: '`down`（默认）/ `up` / `top` / `bottom`。down/up 是相对滚动，top/bottom 是绝对跳到首尾',
    },
    {
      name: 'delay_ms',
      type: 'int',
      help: '每次滚动后的等待毫秒数。默认在 [800,1500] 抖动；0 表示无等待',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    const tabId = tab.id!;
    const times = Math.max(1, Math.min(30, Math.floor(Number(kwargs.times ?? 3))));
    const direction = String(kwargs.direction ?? 'down').toLowerCase();
    if (!['down', 'up', 'top', 'bottom'].includes(direction)) {
      throw new Error(`direction must be one of down/up/top/bottom; got "${direction}"`);
    }
    const delaySpec = kwargs.delay_ms;
    const fixedDelay = delaySpec === undefined ? null : Math.max(0, Number(delaySpec));

    const steps: Array<{ before: number; after: number; height: number }> = [];
    for (let i = 0; i < times; i++) {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (dir: string) => {
          const before = window.scrollY;
          const height = Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
          );
          const vh = window.innerHeight;
          if (dir === 'top') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } else if (dir === 'bottom') {
            window.scrollTo({ top: height, behavior: 'smooth' });
          } else {
            // Random fraction of viewport in [0.7, 1.0] for human-ish stride.
            const step = vh * (0.7 + Math.random() * 0.3);
            window.scrollBy({ top: dir === 'up' ? -step : step, behavior: 'smooth' });
          }
          return { before, after: window.scrollY, height };
        },
        args: [direction],
      });
      const step = res[0]?.result;
      if (step) steps.push(step);
      if (i < times - 1) {
        const wait = fixedDelay ?? 800 + Math.floor(Math.random() * 700);
        if (wait > 0) await sleep(wait);
      } else {
        // Always pause a beat after the LAST scroll so lazy-load XHRs can settle.
        await sleep(fixedDelay ?? 800);
      }
    }

    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        scrollY: window.scrollY,
        pageHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        ),
        viewport: window.innerHeight,
        atBottom: window.scrollY + window.innerHeight + 4 >= document.documentElement.scrollHeight,
      }),
    });
    return {
      tabId,
      direction,
      scrolls_performed: steps.length,
      ...(probe[0]?.result ?? {}),
    };
  },
});
