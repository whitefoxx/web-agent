/**
 * Recorder buffering / truncation / sequencing logic. Persistence is injected
 * (sinks), so this runs in node with no IndexedDB — same approach as
 * install-manager.test.ts. trace-store itself no-ops in node and is smoke-tested
 * for that contract at the bottom.
 */

import { describe, it, expect } from 'vitest';
import { Recorder } from '../src/explore/recorder';
import { emptyCounts, type TraceEvent, type TraceMeta } from '../src/explore/types';
import { createTrace, getTrace, listTraces, appendEvents } from '../src/explore/trace-store';

function fixedClock(start = 1000, step = 1): () => number {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

function newMeta(traceId = 't1'): TraceMeta {
  return { traceId, status: 'recording', startedAt: 0, updatedAt: 0, counts: emptyCounts() };
}

function collector() {
  const events: TraceEvent[] = [];
  const metas: TraceMeta[] = [];
  return {
    events,
    metas,
    sinks: {
      events: (_id: string, evs: TraceEvent[]) => {
        events.push(...evs);
      },
      meta: (m: TraceMeta) => {
        metas.push({ ...m, counts: { ...m.counts } });
      },
    },
  };
}

describe('Recorder.resume (Explore v2 append)', () => {
  it('continues seq from startSeq and flips status back to recording', async () => {
    const c = collector();
    const meta: TraceMeta = { ...newMeta('tR'), status: 'done' };
    const r = await Recorder.resume(meta, 5, { now: fixedClock(), flushEveryN: 1 }, c.sinks);
    expect(r.nextSeq).toBe(5);
    expect(r.meta.status).toBe('recording');
    r.recordAction({ stream: 'action', tool: 'open_url', status: 'ok' });
    await r.flush();
    expect(c.events.map((e) => e.seq)).toEqual([5]); // no collision with seq 0..4
    expect(r.nextSeq).toBe(6);
  });

  it('clamps a negative startSeq to 0', async () => {
    const c = collector();
    const r = await Recorder.resume(newMeta('tR2'), -3, { flushEveryN: 1 }, c.sinks);
    expect(r.nextSeq).toBe(0);
  });
});

describe('Recorder sequencing & counts', () => {
  it('assigns monotonic seq + clock ts across streams and bumps per-stream counts', async () => {
    const c = collector();
    const r = new Recorder(newMeta(), { now: fixedClock(), flushEveryN: 100 }, c.sinks);
    r.recordAction({ stream: 'action', tool: 'open_url', status: 'ok' });
    r.recordNetwork({ stream: 'network', source: 'cdp', url: 'https://x/a', method: 'GET' });
    r.recordState({ stream: 'state', url: 'https://x/a' });
    await r.flush();

    expect(c.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(c.events.map((e) => e.ts)).toEqual([1000, 1001, 1002]);
    expect(r.meta.counts).toMatchObject({ action: 1, network: 1, state: 1, console: 0, error: 0 });
  });
});

describe('Recorder threshold flush', () => {
  it('auto-flushes once the buffer hits flushEveryN', () => {
    const c = collector();
    const r = new Recorder(newMeta(), { now: fixedClock(), flushEveryN: 2 }, c.sinks);
    r.recordAction({ stream: 'action', tool: 'a', status: 'ok' });
    expect(c.events).toHaveLength(0); // below threshold
    r.recordAction({ stream: 'action', tool: 'b', status: 'ok' });
    expect(c.events).toHaveLength(2); // threshold hit → flushed synchronously
    expect(r.pendingCount).toBe(0);
  });
});

describe('Recorder body truncation', () => {
  it('truncates an over-long response body and records the full size', async () => {
    const c = collector();
    const r = new Recorder(
      newMeta(),
      { now: fixedClock(), maxBodyChars: 10, flushEveryN: 100 },
      c.sinks,
    );
    r.recordNetwork({
      stream: 'network',
      source: 'cdp',
      url: 'https://x/big',
      method: 'GET',
      responseBody: '0123456789ABCDEF', // 16 chars
    });
    await r.flush();
    const ev = c.events[0] as Extract<TraceEvent, { stream: 'network' }>;
    expect(ev.responseBody).toBe('0123456789');
    expect(ev.responseBodyFullSize).toBe(16);
    expect(ev.responseBodyTruncated).toBe(true);
  });

  it('drops bodies once the session budget is exhausted but keeps the record', async () => {
    const c = collector();
    const r = new Recorder(
      newMeta(),
      { now: fixedClock(), maxBodyChars: 1000, maxTotalBodyChars: 5, flushEveryN: 100 },
      c.sinks,
    );
    r.recordNetwork({
      stream: 'network',
      source: 'cdp',
      url: 'https://x/1',
      method: 'GET',
      responseBody: '12345',
    });
    r.recordNetwork({
      stream: 'network',
      source: 'cdp',
      url: 'https://x/2',
      method: 'GET',
      responseBody: 'abcde',
    });
    await r.flush();
    const [a, b] = c.events as Extract<TraceEvent, { stream: 'network' }>[];
    expect(a.responseBody).toBe('12345'); // fills the budget (0 < 5 at record time)
    expect(b.responseBody).toBeUndefined(); // budget now exhausted → dropped
    expect(b.responseBodyTruncated).toBe(true);
    expect(b.responseBodyFullSize).toBe(5);
  });
});

describe('Recorder action digest cap', () => {
  it('truncates resultDigest to maxDigestChars', async () => {
    const c = collector();
    const r = new Recorder(
      newMeta(),
      { now: fixedClock(), maxDigestChars: 5, flushEveryN: 100 },
      c.sinks,
    );
    r.recordAction({
      stream: 'action',
      tool: 'get_page_text',
      status: 'ok',
      resultDigest: 'abcdefghij',
    });
    await r.flush();
    const ev = c.events[0] as Extract<TraceEvent, { stream: 'action' }>;
    expect(ev.resultDigest).toBe('abcde');
  });
});

describe('Recorder finalize', () => {
  it('flushes the tail and marks the trace done; further records are ignored', async () => {
    const c = collector();
    const r = new Recorder(newMeta(), { now: fixedClock(), flushEveryN: 100 }, c.sinks);
    r.recordAction({ stream: 'action', tool: 'a', status: 'ok' });
    await r.finalize();
    expect(r.meta.status).toBe('done');
    expect(c.events).toHaveLength(1);
    r.recordAction({ stream: 'action', tool: 'after', status: 'ok' });
    await r.flush();
    expect(c.events).toHaveLength(1); // post-finalize record ignored
  });
});

describe('Recorder.create persists initial meta via the sink', () => {
  it('emits a recording-status meta on create', async () => {
    const c = collector();
    await Recorder.create(
      { traceId: 't9', site: 'demo', task: 'go' },
      { now: fixedClock() },
      c.sinks,
    );
    expect(c.metas).toHaveLength(1);
    expect(c.metas[0]).toMatchObject({ traceId: 't9', site: 'demo', status: 'recording' });
  });
});

describe('trace-store node no-op contract', () => {
  it('reads return empty and writes do not throw without IndexedDB', async () => {
    await expect(createTrace(newMeta('n1'))).resolves.toBeUndefined();
    await expect(
      appendEvents('n1', [{ stream: 'action', seq: 0, ts: 0, tool: 'x', status: 'ok' }]),
    ).resolves.toBeUndefined();
    expect(await getTrace('n1')).toBeNull();
    expect(await listTraces()).toEqual([]);
  });
});
