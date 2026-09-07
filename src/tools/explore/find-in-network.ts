import { cli } from '@base/runtime/registry.js';
import { getActiveExploreSession } from '../../explore/session';
import { getTraceEvents } from '../../explore/trace-store';
import type { TraceNetworkEvent } from '../../explore/types';

/**
 * Explore-time reverse lookup: "I see this value on the page — which captured
 * response actually returned it?" Searches the trace's network response bodies
 * for the text and returns the matching endpoints (+ a snippet around the hit).
 * The fast way to find the real data source on API-driven sites. Explore only.
 */
cli({
  site: 'generic',
  name: 'find_in_network',
  access: 'read',
  description:
    '[Explore mode only] Reverse lookup: which captured endpoint returned a value you see on the page (a title/number/ID etc.). Give a piece of text and it returns the endpoint whose response body contains it + the matched fragment. Use it to quickly pin down "which API the data really comes from".',
  args: [
    {
      name: 'text',
      type: 'string',
      required: true,
      help: 'Text to look up (part of a value seen on the page — the more distinctive, the better)',
    },
    { name: 'limit', type: 'int', default: 5, help: 'Max endpoints to return (default 5, cap 20)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    if (!session) {
      return { error: 'no active explore session — find_in_network is only available while an explore recording is in progress' };
    }
    const needle = typeof kwargs.text === 'string' ? kwargs.text.trim() : '';
    if (!needle) return { error: 'text must not be empty' };
    const limit = Math.max(1, Math.min(Number(kwargs.limit ?? 5) || 5, 20));
    const lc = needle.toLowerCase();

    await session.recorder.flush().catch(() => {});
    const events = await getTraceEvents(session.traceId);
    const hits: TraceNetworkEvent[] = [];
    for (const e of events) {
      if (e.stream !== 'network') continue;
      const body = e.responseBody;
      if (typeof body === 'string' && body.toLowerCase().includes(lc)) hits.push(e);
    }
    if (hits.length === 0) {
      return {
        count: 0,
        hint: 'No endpoint response body contains that text — it may be server-rendered (data is directly in the HTML; use get_html / query_dom to scrape the DOM), or the text was escaped/split; try a shorter, more distinctive substring.',
      };
    }
    return {
      count: hits.length,
      matches: hits.slice(0, limit).map((n) => {
        const body = n.responseBody ?? '';
        const idx = body.toLowerCase().indexOf(lc);
        const snippet =
          idx >= 0 ? body.slice(Math.max(0, idx - 80), idx + needle.length + 200) : undefined;
        return {
          method: n.method,
          url: n.url,
          status: n.status,
          contentType: n.contentType,
          snippet,
        };
      }),
    };
  },
});
