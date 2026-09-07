/**
 * adapter-health-store — the pure folding + status logic (H1-P1). IDB CRUD is
 * best-effort and skipped in node (same as memory/notes stores), so we test the
 * pure core: applyOutcome's rolling window + drift counter, and computeHealthStatus.
 */

import { describe, it, expect } from 'vitest';
import {
  applyOutcome,
  computeHealthStatus,
  isDriftKind,
  BROKEN_THRESHOLD,
  type AdapterHealth,
  type HealthErrorKind,
} from '../src/adapters/adapter-health-store';

const ID = 'zhihu/search';

function fold(kinds: Array<true | HealthErrorKind>): AdapterHealth {
  // true = ok run; a HealthErrorKind = a failed run of that kind
  let h: AdapterHealth | undefined;
  let ts = 1000;
  for (const k of kinds) {
    h = applyOutcome(h, { ts: ts++, ok: k === true, kind: k === true ? undefined : k }, ID, 'err');
  }
  return h!;
}

describe('isDriftKind', () => {
  it('treats empty/generic as drift; auth/rate/tab as not', () => {
    expect(isDriftKind('empty')).toBe(true);
    expect(isDriftKind('generic')).toBe(true);
    expect(isDriftKind('auth_required')).toBe(false);
    expect(isDriftKind('rate_limited')).toBe(false);
    expect(isDriftKind('tab')).toBe(false);
    expect(isDriftKind(undefined)).toBe(false);
  });
});

describe('applyOutcome', () => {
  it('counts consecutive drift fails and resets on ok', () => {
    expect(fold(['generic', 'generic']).consecutiveDriftFails).toBe(2);
    expect(fold(['generic', 'generic', true]).consecutiveDriftFails).toBe(0);
    expect(fold(['generic', true, 'empty']).consecutiveDriftFails).toBe(1);
  });
  it('a blocked/infra fail does NOT touch the drift counter', () => {
    expect(fold(['generic', 'auth_required']).consecutiveDriftFails).toBe(1); // unchanged
    expect(fold(['generic', 'rate_limited', 'generic']).consecutiveDriftFails).toBe(2);
    expect(fold(['tab']).consecutiveDriftFails).toBe(0);
  });
  it('tracks lastOkTs ("last worked"), lastStatus, lastErrorKind, runs', () => {
    const h = fold([true, 'generic']);
    expect(h.runs).toBe(2);
    expect(h.lastStatus).toBe('fail');
    expect(h.lastErrorKind).toBe('generic');
    expect(h.lastError).toBe('err');
    expect(h.lastOkTs).toBe(1000); // the earlier ok
  });
  it('caps the rolling window at 20', () => {
    const h = fold(Array(30).fill(true) as true[]);
    expect(h.recent).toHaveLength(20);
    expect(h.runs).toBe(30);
  });
  it('clears lastError/lastErrorKind on a successful run', () => {
    const h = fold(['generic', true]);
    expect(h.lastErrorKind).toBeUndefined();
    expect(h.lastError).toBeUndefined();
  });
  it('preserves agent notes across outcome writes (F-35: ⑩ note must survive later runs)', () => {
    const withNote: AdapterHealth = {
      id: ID,
      runs: 1,
      lastRunTs: 1,
      lastStatus: 'ok',
      consecutiveDriftFails: 0,
      recent: [],
      notes: [{ ts: 1, text: '接口 2026 改版了' }],
    };
    // A routine success AND a routine failure after the note must NOT wipe it.
    const afterOk = applyOutcome(withNote, { ts: 2, ok: true }, ID);
    expect(afterOk.notes).toEqual([{ ts: 1, text: '接口 2026 改版了' }]);
    const afterFail = applyOutcome(afterOk, { ts: 3, ok: false, kind: 'generic' }, ID, 'boom');
    expect(afterFail.notes).toEqual([{ ts: 1, text: '接口 2026 改版了' }]);
  });
});

describe('broken transition (P2c notifier trigger)', () => {
  it('consecutiveDriftFails equals BROKEN_THRESHOLD exactly on the transition, then exceeds it', () => {
    expect(
      fold(Array(BROKEN_THRESHOLD).fill('generic') as HealthErrorKind[]).consecutiveDriftFails,
    ).toBe(BROKEN_THRESHOLD);
    expect(
      fold(Array(BROKEN_THRESHOLD + 1).fill('generic') as HealthErrorKind[]).consecutiveDriftFails,
    ).toBe(BROKEN_THRESHOLD + 1);
  });
});

describe('computeHealthStatus', () => {
  it('unknown when there are no runs', () => {
    expect(computeHealthStatus(undefined)).toBe('unknown');
  });
  it('healthy after a success (even following past fails)', () => {
    expect(computeHealthStatus(fold([true]))).toBe('healthy');
    expect(computeHealthStatus(fold(['generic', 'generic', true]))).toBe('healthy');
  });
  it('blocked when the last fail is auth/rate/tab (site-side, not drift)', () => {
    expect(computeHealthStatus(fold(['auth_required']))).toBe('blocked');
    expect(computeHealthStatus(fold(['generic', 'rate_limited']))).toBe('blocked');
    expect(computeHealthStatus(fold(['tab']))).toBe('blocked');
  });
  it('degraded on 1–2 consecutive drift fails, broken at the threshold', () => {
    expect(computeHealthStatus(fold(['generic']))).toBe('degraded');
    expect(computeHealthStatus(fold(['generic', 'empty']))).toBe('degraded');
    expect(
      computeHealthStatus(fold(Array(BROKEN_THRESHOLD).fill('generic') as HealthErrorKind[])),
    ).toBe('broken');
  });
});
