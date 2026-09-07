/**
 * Resilience primitives (src/agent/resilience.ts) — bounded retry + thrash
 * breaker. All deterministic: randomness/clock are injected. See
 * docs/agent-harness.md §10.1.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_THRASH,
  NoProgressTracker,
  ThrashTracker,
  isRetriableNetworkError,
  isRetriableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleep,
  toolCallKey,
} from '../src/agent/resilience';

describe('isRetriableStatus', () => {
  it('retries 408/429 and every 5xx', () => {
    for (const s of [408, 429, 500, 502, 503, 504, 599]) expect(isRetriableStatus(s)).toBe(true);
  });
  it('does NOT retry other 4xx (caller errors that will not self-heal)', () => {
    for (const s of [400, 401, 403, 404, 422]) expect(isRetriableStatus(s)).toBe(false);
  });
  it('does not retry 2xx/3xx', () => {
    for (const s of [200, 204, 301, 302]) expect(isRetriableStatus(s)).toBe(false);
  });
});

describe('isRetriableNetworkError', () => {
  it('retries a TypeError (fetch network failure)', () => {
    expect(isRetriableNetworkError(new TypeError('Failed to fetch'))).toBe(true);
  });
  it('never retries an AbortError (user hit Stop)', () => {
    expect(isRetriableNetworkError(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });
  it('does not retry a generic Error (e.g. our thrown "LLM API error")', () => {
    expect(isRetriableNetworkError(new Error('LLM API error 400'))).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });
  it('parses an HTTP-date relative to an injected now', () => {
    const now = 1_700_000_000_000;
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBeCloseTo(30, 0);
  });
  it('returns undefined for missing/garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
  it('clamps negatives to 0', () => {
    expect(parseRetryAfter('-5')).toBe(0);
  });
});

describe('retryDelayMs', () => {
  const policy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 8000 };
  it('grows exponentially per attempt (rand=1 → full delay)', () => {
    expect(retryDelayMs(0, policy, undefined, 1)).toBe(1000);
    expect(retryDelayMs(1, policy, undefined, 1)).toBe(2000);
    expect(retryDelayMs(2, policy, undefined, 1)).toBe(4000);
  });
  it('applies the 50% jitter floor (rand=0)', () => {
    expect(retryDelayMs(1, policy, undefined, 0)).toBe(1000); // 2000 * 0.5
  });
  it('caps at maxDelayMs', () => {
    expect(retryDelayMs(10, policy, undefined, 1)).toBe(8000);
  });
  it('honors Retry-After over computed backoff, still capped', () => {
    expect(retryDelayMs(0, policy, 3, 1)).toBe(3000);
    expect(retryDelayMs(0, policy, 999, 1)).toBe(8000);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });
  it('rejects immediately if the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(50, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects when aborted mid-wait', async () => {
    const ac = new AbortController();
    const p = sleep(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('toolCallKey', () => {
  it('is stable for equal (tool,args)', () => {
    expect(toolCallKey('x__y', { a: 1 })).toBe(toolCallKey('x__y', { a: 1 }));
  });
  it('differs when args differ', () => {
    expect(toolCallKey('x__y', { a: 1 })).not.toBe(toolCallKey('x__y', { a: 2 }));
  });
  it('tolerates unserializable args (cyclic)', () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(typeof toolCallKey('t', cyc)).toBe('string');
  });
});

describe('ThrashTracker', () => {
  it('breaks after N consecutive same-call failures', () => {
    const t = new ThrashTracker({ maxSameFailure: 3 });
    const k = toolCallKey('a__b', { q: 1 });
    expect(t.record(k, false)).toBeNull();
    expect(t.record(k, false)).toBeNull();
    expect(t.record(k, false)).toMatch(/tripped the breaker/);
  });
  it('a success resets the streak', () => {
    const t = new ThrashTracker({ maxSameFailure: 2 });
    const k = toolCallKey('a__b', {});
    expect(t.record(k, false)).toBeNull();
    expect(t.record(k, true)).toBeNull();
    expect(t.record(k, false)).toBeNull(); // streak restarted, not at threshold
  });
  it('tracks distinct calls independently', () => {
    const t = new ThrashTracker({ maxSameFailure: 2 });
    expect(t.record(toolCallKey('a', {}), false)).toBeNull();
    expect(t.record(toolCallKey('b', {}), false)).toBeNull();
    expect(t.record(toolCallKey('a', {}), false)).toMatch(/tripped the breaker/);
  });
  it('ships sane defaults', () => {
    expect(DEFAULT_THRASH.maxSameFailure).toBe(3);
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
  });
});

describe('NoProgressTracker', () => {
  it('does not trip while tools keep succeeding', () => {
    const t = new NoProgressTracker({ maxStalls: 3 });
    for (let i = 0; i < 10; i++) expect(t.record(0, true)).toBeNull();
  });
  it('does not trip while the plan keeps progressing', () => {
    const t = new NoProgressTracker({ maxStalls: 3 });
    for (let i = 1; i <= 10; i++) expect(t.record(i, false)).toBeNull();
  });
  it('trips only after N turns with NO progress AND NO success', () => {
    const t = new NoProgressTracker({ maxStalls: 3 });
    expect(t.record(2, true)).toBeNull(); // baseline (completed rose to 2)
    expect(t.record(2, false)).toBeNull(); // stall 1
    expect(t.record(2, false)).toBeNull(); // stall 2
    expect(t.record(2, false)).toMatch(/looks stuck/); // stall 3 → trip
  });
  it('a single success resets the stall counter', () => {
    const t = new NoProgressTracker({ maxStalls: 2 });
    expect(t.record(1, false)).toBeNull();
    expect(t.record(1, true)).toBeNull(); // reset
    expect(t.record(1, false)).toBeNull(); // back to 1 stall, not at threshold
  });
});
