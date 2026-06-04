import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';
import { getActiveExploreSession } from '../../explore/session';

/**
 * Explore-time perception primitive: raw outerHTML of a tab (optionally a
 * single selector subtree), so the LLM can see DOM structure and decide on
 * scrape selectors when no clean API endpoint exists. Complements
 * get_page_text (which returns visible text only).
 *
 * Targets the active explore tab by default; a `tab_id` (from open_url) works
 * standalone too. Runs in the ISOLATED content world via chrome.scripting —
 * independent of the explore session's CDP attachment. When it reads the
 * explore tab, it also records a `state` snapshot into the trace.
 */
cli({
  site: 'generic',
  name: 'get_html',
  access: 'read',
  description:
    '获取标签页的原始 HTML（outerHTML，可截断）。看清 DOM 结构、决定抓取选择器时用。不传 tab_id 时默认取当前 explore 会话的标签页。',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      help: '目标标签页 id（来自 open_url）。省略则用 explore 会话的标签页',
    },
    { name: 'selector', type: 'string', help: '只取匹配该 CSS 选择器的第一个元素的 outerHTML' },
    {
      name: 'max_chars',
      type: 'int',
      default: 50000,
      help: '最多返回多少字符（默认 50000，上限 500000）',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      throw new Error('provide tab_id, or start an explore session first');
    }

    const selector =
      typeof kwargs.selector === 'string' && kwargs.selector.trim() ? kwargs.selector.trim() : null;
    const maxChars = Math.max(1000, Math.min(Number(kwargs.max_chars ?? 50000) || 50000, 500000));

    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string | null) => {
        const el = sel ? document.querySelector(sel) : document.documentElement;
        return {
          url: location.href,
          title: document.title,
          html: el instanceof HTMLElement ? el.outerHTML : '',
          found: !!el,
        };
      },
      args: [selector],
    });
    const out = res[0]?.result as
      | { url: string; title: string; html: string; found: boolean }
      | undefined;
    if (!out) throw new Error('failed to read page HTML (tab not scriptable on this URL?)');

    const fullLength = out.html.length;
    const truncated = fullLength > maxChars;
    const html = truncated ? out.html.slice(0, maxChars) : out.html;

    // Snapshot into the trace when reading the explore tab.
    if (session && tabId === session.tabId) {
      session.recordState({
        stream: 'state',
        url: out.url,
        title: out.title,
        html,
        label: selector ?? 'get_html',
      });
    }

    return {
      url: out.url,
      title: out.title,
      found: out.found,
      htmlLength: fullLength,
      truncated,
      html,
    };
  },
});
