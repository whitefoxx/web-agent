import { cli } from '../../runtime/registry.js';
import { getActiveExploreSession } from '../../explore/session';

/**
 * Explore-time perception primitive: list the XHR/Fetch endpoints captured so
 * far in the active explore session, deduped by `method + origin + pathname`
 * (query stripped, so signed/volatile params collapse). Lets the LLM discover
 * which endpoint actually serves the data before synthesizing an adapter.
 *
 * No-op-with-message when no explore session is active.
 */
cli({
  site: 'generic',
  name: 'list_network',
  access: 'read',
  description:
    '列出当前 explore 录制中捕获到的 XHR/Fetch 接口（按 method+路径去重汇总）。用于发现数据真正来自哪个接口。仅在 explore 录制进行中可用。',
  args: [
    { name: 'filter', type: 'string', help: '只返回 URL 含该子串的接口' },
    { name: 'limit', type: 'int', default: 50, help: '最多返回多少个接口（默认 50，上限 200）' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    if (!session) {
      return { error: 'no active explore session — list_network 仅在 explore 录制进行中可用' };
    }
    const filter = typeof kwargs.filter === 'string' ? kwargs.filter.trim() : '';
    const limit = Math.max(1, Math.min(Number(kwargs.limit ?? 50) || 50, 200));
    let items = session.networkSummary();
    if (filter) {
      items = items.filter((i) => i.sampleUrl.includes(filter) || i.endpoint.includes(filter));
    }
    // Most-called endpoints first — the data endpoint is usually hit repeatedly
    // (pagination, scroll) while one-off assets are not.
    items = items.sort((a, b) => b.count - a.count).slice(0, limit);
    return {
      count: items.length,
      hint: '挑出返回业务数据的接口后，用 get_html 或在合成阶段查看响应体决定抓取策略。',
      endpoints: items.map((i) => ({
        method: i.method,
        endpoint: i.endpoint,
        status: i.status,
        contentType: i.contentType,
        type: i.resourceType,
        hasBody: i.hasBody,
        calls: i.count,
        sampleUrl: i.sampleUrl,
      })),
    };
  },
});
