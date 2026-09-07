import { cli } from '@base/runtime/registry.js';
import { getActiveExploreSession } from '../../explore/session';
import { getTraceEvents } from '../../explore/trace-store';
import type { TraceNetworkEvent } from '../../explore/types';

/**
 * Explore-time perception primitive: the FULL request/response body of a
 * captured XHR/Fetch endpoint, read from the trace. `list_network` only shows
 * the deduped endpoint summary (has-body flag, no body) — this is how the agent
 * actually inspects what an endpoint returned so it can decide the data path
 * (and synthesize a correct adapter). Explore session only.
 */
cli({
  site: 'generic',
  name: 'read_network',
  access: 'read',
  description:
    'View the [full request/response body] of an XHR/Fetch endpoint in the explore recording (read from the trace). Use list_network to find the endpoint first, then this tool to see what data it actually returned and decide the extraction strategy. Only available while an explore recording is in progress.',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: 'Endpoint URL or a substring of it (matches the endpoint / sampleUrl in list_network)',
    },
    {
      name: 'max_chars',
      type: 'int',
      default: 8000,
      help: 'Max characters to return per response body (default 8000, cap 200000)',
    },
    { name: 'limit', type: 'int', default: 3, help: 'Max matching requests to return (default 3, cap 20)' },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    if (!session) {
      return { error: 'no active explore session — read_network is only available while an explore recording is in progress' };
    }
    const needle = typeof kwargs.url === 'string' ? kwargs.url.trim() : '';
    if (!needle) return { error: 'url must not be empty' };
    const maxChars = Math.max(200, Math.min(Number(kwargs.max_chars ?? 8000) || 8000, 200000));
    const limit = Math.max(1, Math.min(Number(kwargs.limit ?? 3) || 3, 20));

    // Flush buffered events so the just-fired request is readable.
    await session.recorder.flush().catch(() => {});
    const events = await getTraceEvents(session.traceId);
    const nets = events.filter(
      (e): e is TraceNetworkEvent => e.stream === 'network' && e.url.includes(needle),
    );
    if (nets.length === 0) {
      return {
        count: 0,
        hint: 'No matching endpoint; use list_network first to see which endpoints were captured, then use one of their endpoint substrings.',
      };
    }
    // Prefer requests that actually carry a body; keep the most recent few.
    const withBody = nets.filter((n) => n.responseBody);
    const chosen = (withBody.length ? withBody : nets).slice(-limit);
    return {
      count: chosen.length,
      matched: nets.length,
      requests: chosen.map((n) => ({
        method: n.method,
        url: n.url,
        status: n.status,
        contentType: n.contentType,
        requestBody: n.requestBody ? n.requestBody.slice(0, 2000) : undefined,
        responseBody: n.responseBody ? n.responseBody.slice(0, maxChars) : undefined,
        responseTruncated: n.responseBody
          ? n.responseBody.length > maxChars
          : n.responseBodyTruncated,
      })),
    };
  },
});
