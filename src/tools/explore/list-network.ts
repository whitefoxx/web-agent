import { cli } from '@base/runtime/registry.js';
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
    'List the XHR/Fetch endpoints captured in the current explore recording (deduped and summarized by method+path). Use it to discover which endpoint the data really comes from. Only available while an explore recording is in progress.',
  args: [
    { name: 'filter', type: 'string', help: 'Only return endpoints whose URL contains this substring' },
    { name: 'limit', type: 'int', default: 50, help: 'Max endpoints to return (default 50, cap 200)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    if (!session) {
      return { error: 'no active explore session — list_network is only available while an explore recording is in progress' };
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
      hint: 'Once you pick the endpoint that returns the business data, use get_html or inspect the response body during synthesis to decide the extraction strategy.',
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
