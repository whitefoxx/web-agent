/**
 * ExploreSession orchestration + the pure network-summary dedup. CDP and the
 * trace-store are injected (deps + collector sinks), so this runs in node with
 * no chrome.* — same approach as install-manager.test.ts / explore-recorder.test.ts.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExploreSession,
  getActiveExploreSession,
  endpointKey,
  mergeNetSummary,
  type NetSummaryItem,
} from '../src/explore/session';
import { Recorder } from '../src/explore/recorder';
import { emptyCounts, type TraceEvent, type TraceMeta } from '../src/explore/types';
import type { CapturedNetworkEvent } from '../src/runtime/network-recorder';

function fixedClock(start = 1000): () => number {
  let t = start;
  return () => t++;
}

function recorderWithCollector() {
  const events: TraceEvent[] = [];
  const meta: TraceMeta = {
    traceId: 't1',
    status: 'recording',
    startedAt: 0,
    updatedAt: 0,
    counts: emptyCounts(),
  };
  const rec = new Recorder(
    meta,
    { now: fixedClock(), flushEveryN: 1 },
    {
      events: (_id: string, evs: TraceEvent[]) => {
        events.push(...evs);
      },
      meta: () => {},
    },
  );
  return { rec, events };
}

const netEvent = (
  url: string,
  method = 'GET',
  extra: Partial<CapturedNetworkEvent> = {},
): CapturedNetworkEvent => ({ stream: 'network', source: 'cdp', url, method, ...extra });

afterEach(async () => {
  // Defensive: never leak an active session across tests.
  const s = getActiveExploreSession();
  if (s) await s.stop('aborted');
});

describe('endpointKey / mergeNetSummary', () => {
  it('strips query and dedups by method+path with counts + hasBody', () => {
    const m = new Map<string, NetSummaryItem>();
    mergeNetSummary(
      m,
      netEvent('https://x.com/api/feed?token=a&page=1', 'GET', {
        status: 200,
        contentType: 'application/json',
        responseBody: '{"a":1}',
      }),
    );
    mergeNetSummary(m, netEvent('https://x.com/api/feed?token=b&page=2', 'GET', { status: 200 }));
    expect(m.size).toBe(1);
    const item = [...m.values()][0];
    expect(item.endpoint).toBe('https://x.com/api/feed');
    expect(item.count).toBe(2);
    expect(item.hasBody).toBe(true); // sticky from the first
    expect(item.sampleUrl).toContain('page=2'); // latest sample
  });

  it('keeps different methods and paths separate', () => {
    const m = new Map<string, NetSummaryItem>();
    mergeNetSummary(m, netEvent('https://x/a', 'GET'));
    mergeNetSummary(m, netEvent('https://x/a', 'POST'));
    mergeNetSummary(m, netEvent('https://x/b', 'GET'));
    expect(m.size).toBe(3);
  });

  it('endpointKey falls back gracefully on a non-URL', () => {
    expect(endpointKey('GET', 'not a url')).toBe('GET not a url');
  });
});

describe('ExploreSession orchestration (injected deps)', () => {
  it('routes network → recorder+summary, records actions, manages active, stops cleanly', async () => {
    const { rec, events } = recorderWithCollector();
    let captured: ((e: CapturedNetworkEvent) => void) | null = null;
    const stop = vi.fn(async () => {});

    const session = await ExploreSession.start(
      { traceId: 't1', tabId: 42, site: 'demo', task: 'go' },
      {
        createRecorder: async () => rec,
        createNetworkRecorder: async (_tabId, onEvent) => {
          captured = onEvent;
          return { stop };
        },
      },
    );

    expect(getActiveExploreSession()).toBe(session);
    expect(session.tabId).toBe(42);

    captured!(netEvent('https://x/api/feed?p=1', 'GET', { status: 200, responseBody: '{}' }));
    captured!(netEvent('https://x/api/feed?p=2', 'GET', { status: 200 }));
    expect(session.networkSummary()).toHaveLength(1);
    expect(session.networkSummary()[0].count).toBe(2);

    session.recordAction({ stream: 'action', tool: 'open_url', status: 'ok' });

    const streams = events.map((e) => e.stream);
    expect(streams.filter((s) => s === 'network')).toHaveLength(2);
    expect(streams.filter((s) => s === 'action')).toHaveLength(1);

    await session.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.isStopped).toBe(true);
    expect(getActiveExploreSession()).toBeNull();
    expect(rec.meta.status).toBe('done');
  });

  it('refuses to start a second session while one is active', async () => {
    const { rec } = recorderWithCollector();
    const stop = vi.fn(async () => {});
    const deps = {
      createRecorder: async () => rec,
      createNetworkRecorder: async () => ({ stop }),
    };
    const s1 = await ExploreSession.start({ traceId: 'a', tabId: 1 }, deps);
    await expect(ExploreSession.start({ traceId: 'b', tabId: 2 }, deps)).rejects.toThrow(
      /already active/,
    );
    await s1.stop();
  });
});

describe('ExploreSession v2: cursor / adapter ids / findings', () => {
  const noNet = { createNetworkRecorder: async () => ({ stop: async () => {} }) };

  it('advanceCursor moves the slice boundary to the recorder high-water', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.start(
      { traceId: 't1', tabId: 1 },
      { createRecorder: async () => rec, ...noNet },
    );
    expect(session.cursor).toBe(0);
    session.recordAction({ stream: 'action', tool: 'open_url', status: 'ok' });
    session.recordAction({ stream: 'action', tool: 'list_network', status: 'ok' });
    session.advanceCursor();
    expect(session.cursor).toBe(2); // first op = events [0,1]
    session.recordAction({ stream: 'action', tool: 'get_html', status: 'ok' });
    session.advanceCursor();
    expect(session.cursor).toBe(3); // second op = event [2]
    await session.stop();
  });

  it('recordExtraction keeps rows + producing code; advanceCursor resets both', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.start(
      { traceId: 't1', tabId: 1 },
      { createRecorder: async () => rec, ...noNet },
    );
    expect(session.lastExtraction()).toBeNull();
    expect(session.lastExtractionCode()).toBeNull();
    session.recordExtraction([{ a: 1 }], 'return rows;');
    expect(session.lastExtraction()).toEqual([{ a: 1 }]);
    expect(session.lastExtractionCode()).toBe('return rows;');
    // Rows recorded without code → code resets so the pair never desyncs.
    session.recordExtraction([{ b: 2 }]);
    expect(session.lastExtractionCode()).toBeNull();
    session.recordExtraction([{ c: 3 }], 'return c;');
    session.advanceCursor();
    expect(session.lastExtraction()).toBeNull();
    expect(session.lastExtractionCode()).toBeNull();
    await session.stop();
  });

  it('mints stable, incrementing adapter ids and counts them', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.start(
      { traceId: 'tX', tabId: 1 },
      { createRecorder: async () => rec, ...noNet },
    );
    expect(session.adapterCount).toBe(0);
    expect(session.nextAdapterId()).toBe('tX__a1');
    expect(session.nextAdapterId()).toBe('tX__a2');
    expect(session.adapterCount).toBe(2);
    await session.stop();
  });

  it('records findings (deduped) once a site is set, and formats them for the prompt', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.start(
      { traceId: 't1', tabId: 1 },
      { createRecorder: async () => rec, ...noNet },
    );
    // No site yet → recordFinding is a no-op.
    session.recordFinding({ kind: 'fact', text: 'before site', ts: 1 });
    expect(session.findingsNote()).toBe('');
    session.setSite('demo');
    session.recordFinding({ kind: 'endpoint', text: 'data from /api/feed', ts: 2 });
    session.recordFinding({ kind: 'endpoint', text: 'data from /api/feed', ts: 3 }); // dup
    session.recordFinding({ kind: 'selector', text: '.item', ts: 4 });
    const note = session.findingsNote();
    expect(note).toContain('Known info about this site');
    expect(note).toContain('(endpoint) data from /api/feed');
    expect(note).toContain('(selector) .item');
    expect(note.match(/data from \/api\/feed/g)).toHaveLength(1); // deduped
    await session.stop();
  });

  it('setSite is idempotent — the first navigation wins', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.start(
      { traceId: 't1', tabId: 1 },
      { createRecorder: async () => rec, ...noNet },
    );
    session.setSite('zhihu');
    session.setSite('weibo');
    expect(session.site).toBe('zhihu');
    await session.stop();
  });

  it('resume restores cursor + adapterCount and continues (injected recorder)', async () => {
    const { rec } = recorderWithCollector();
    const session = await ExploreSession.resume(
      { traceId: 't1', tabId: 7, site: 'demo', cursor: 4, adapterCount: 2 },
      { createRecorder: async () => rec, ...noNet },
    );
    expect(session.cursor).toBe(4);
    expect(session.adapterCount).toBe(2);
    expect(session.site).toBe('demo');
    expect(session.nextAdapterId()).toBe('t1__a3'); // continues the count
    await session.stop();
  });
});
