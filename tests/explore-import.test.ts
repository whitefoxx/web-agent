/**
 * parseTraceImport — opencli JSONL + our-own-JSON normalization. Pure, node.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceImport } from '../src/explore/import';
import type { TraceEvent } from '../src/explore/types';

const ID = 'import_test';

describe('parseTraceImport — opencli JSONL (trace.jsonl)', () => {
  const jsonl = [
    JSON.stringify({
      stream: 'action',
      id: 'a1',
      ts: 1000,
      name: 'open',
      phase: 'end',
      data: { argv: ['https://x/'], durationMs: 12 },
    }),
    JSON.stringify({
      stream: 'network',
      id: 'n1',
      ts: 1100,
      url: 'https://x.com/api/feed?p=1',
      method: 'GET',
      status: 200,
      contentType: 'application/json',
      requestHeaders: { 'x-token': 'abc' },
      responseBody: '{"items":[1,2,3]}',
    }),
    JSON.stringify({
      stream: 'state',
      id: 's1',
      ts: 1200,
      url: 'https://x.com/feed',
      snapshot: '<html>…</html>',
    }),
    JSON.stringify({ stream: 'screenshot', id: 'sc1', ts: 1300, format: 'png', data: 'BASE64' }),
  ].join('\n');

  it('maps action/network/state, drops screenshot, fills seq + counts + url', () => {
    const trace = parseTraceImport(jsonl, ID)!;
    expect(trace).not.toBeNull();
    expect(trace.traceId).toBe(ID);
    expect(trace.events.map((e) => e.stream)).toEqual(['action', 'network', 'state']); // screenshot dropped
    expect(trace.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(trace.counts).toMatchObject({ action: 1, network: 1, state: 1 });
    expect(trace.url).toBe('https://x.com/api/feed?p=1'); // first network url
    expect(trace.startedAt).toBe(1000);
    expect(trace.updatedAt).toBe(1200);

    const action = trace.events[0] as Extract<TraceEvent, { stream: 'action' }>;
    expect(action).toMatchObject({
      tool: 'open',
      status: 'ok',
      durationMs: 12,
      args: { argv: ['https://x/'] },
    });

    const net = trace.events[1] as Extract<TraceEvent, { stream: 'network' }>;
    expect(net).toMatchObject({
      url: 'https://x.com/api/feed?p=1',
      method: 'GET',
      status: 200,
      contentType: 'application/json',
      responseBody: '{"items":[1,2,3]}',
    });
    expect(net.requestHeaders).toEqual({ 'x-token': 'abc' });

    const state = trace.events[2] as Extract<TraceEvent, { stream: 'state' }>;
    expect(state.html).toBe('<html>…</html>');
  });

  it('maps a failed action phase to status fail with errorMessage', () => {
    const t = parseTraceImport(
      JSON.stringify({
        stream: 'action',
        ts: 5,
        name: 'click',
        phase: 'error',
        data: { errorMessage: 'boom' },
      }),
      ID,
    )!;
    const a = t.events[0] as Extract<TraceEvent, { stream: 'action' }>;
    expect(a).toMatchObject({ tool: 'click', status: 'fail', errorMessage: 'boom' });
  });

  it('stringifies object request/response bodies', () => {
    const t = parseTraceImport(
      JSON.stringify({
        stream: 'network',
        ts: 1,
        url: 'https://x/a',
        method: 'POST',
        responseBody: { ok: true },
      }),
      ID,
    )!;
    const n = t.events[0] as Extract<TraceEvent, { stream: 'network' }>;
    expect(n.responseBody).toBe('{"ok":true}');
  });
});

describe('parseTraceImport — our exported JSON', () => {
  it('round-trips events and reassigns seq', () => {
    const own = JSON.stringify({
      traceId: 'orig',
      site: 'zhihu',
      task: 'hot',
      url: 'https://www.zhihu.com/hot',
      events: [
        {
          stream: 'network',
          seq: 7,
          ts: 2,
          source: 'cdp',
          url: 'https://www.zhihu.com/api/hot',
          method: 'GET',
          responseBody: '{}',
        },
        { stream: 'action', seq: 9, ts: 3, tool: 'open_url', status: 'ok' },
      ] satisfies TraceEvent[],
    });
    const t = parseTraceImport(own, ID)!;
    expect(t.traceId).toBe(ID); // caller id wins (avoid clobbering an existing trace)
    expect(t.site).toBe('zhihu');
    expect(t.url).toBe('https://www.zhihu.com/hot');
    expect(t.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(t.counts).toMatchObject({ network: 1, action: 1 });
  });
});

describe('parseTraceImport — junk', () => {
  it('returns null on empty / non-event text', () => {
    expect(parseTraceImport('', ID)).toBeNull();
    expect(parseTraceImport('# summary.md\n\nnot json at all', ID)).toBeNull();
    expect(parseTraceImport('{"events":[]}', ID)).toBeNull();
  });
});
