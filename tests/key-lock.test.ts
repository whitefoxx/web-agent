/**
 * Per-key serialization lock (src/tools/key-lock.ts) — the parallel-execution
 * v1 safety primitive. docs/parallel-execution.md §5.
 */
import { describe, expect, it } from 'vitest';
import { withKeyLock } from '../src/tools/key-lock';

/** A task that records when it enters/exits a shared timeline, then resolves
 * after `ms`. Lets us assert overlap (parallel) vs no-overlap (serial). */
function tracked(log: string[], label: string, ms: number): () => Promise<string> {
  return async () => {
    log.push(`${label}:start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${label}:end`);
    return label;
  };
}

describe('withKeyLock', () => {
  it('serializes tasks with the SAME key (no overlap)', async () => {
    const log: string[] = [];
    const key = `same-${Math.random()}`;
    await Promise.all([
      withKeyLock(key, tracked(log, 'A', 30)),
      withKeyLock(key, tracked(log, 'B', 5)),
    ]);
    // B must not start until A ends — strict A then B ordering.
    expect(log).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs DIFFERENT keys in parallel (overlap)', async () => {
    const log: string[] = [];
    const r = Math.random();
    await Promise.all([
      withKeyLock(`x-${r}`, tracked(log, 'A', 30)),
      withKeyLock(`y-${r}`, tracked(log, 'B', 5)),
    ]);
    // Both start before either ends → interleaved.
    expect(log.slice(0, 2).sort()).toEqual(['A:start', 'B:start']);
    // B (shorter) finishes first while A is still running.
    expect(log.indexOf('B:end')).toBeLessThan(log.indexOf('A:end'));
  });

  it('preserves return values and propagates rejections to the caller', async () => {
    const key = `ret-${Math.random()}`;
    await expect(withKeyLock(key, async () => 42)).resolves.toBe(42);
    await expect(
      withKeyLock(key, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('a failing task does NOT wedge the chain (next same-key task still runs)', async () => {
    const key = `wedge-${Math.random()}`;
    await withKeyLock(key, async () => {
      throw new Error('fail');
    }).catch(() => {});
    // The lock tail must have recovered — this must resolve, not hang.
    await expect(withKeyLock(key, async () => 'ok')).resolves.toBe('ok');
  });

  it('queues many same-key tasks in submission order', async () => {
    const log: string[] = [];
    const key = `order-${Math.random()}`;
    await Promise.all([50, 10, 30, 5].map((ms, i) => withKeyLock(key, tracked(log, `t${i}`, ms))));
    expect(log).toEqual([
      't0:start',
      't0:end',
      't1:start',
      't1:end',
      't2:start',
      't2:end',
      't3:start',
      't3:end',
    ]);
  });
});
