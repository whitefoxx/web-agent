/**
 * Per-site tab pool (src/tools/site-tab-pool.ts) — parallel-execution v3. The
 * pool lets same-site adapter calls run on DIFFERENT tabs in parallel (up to a
 * cap) while keeping each tab exclusive to one lease at a time. Chrome is faked
 * via TabOps so the queueing/capacity logic is testable headless.
 * docs/parallel-execution.md §8.
 */
import { describe, expect, it } from 'vitest';
import { SiteTabPool, type TabOps } from '../src/tools/site-tab-pool';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Fake TabOps: counts calls, tracks which tab ids are "alive", lets a test
 * adopt an existing tab or fail the first open. */
function makeFakeOps(opts: { existing?: number; failOpenOnce?: boolean } = {}) {
  let nextId = 100;
  let failOpen = opts.failOpenOnce ?? false;
  const alive = new Set<number>();
  const closed: number[] = [];
  const calls = { findExisting: 0, open: 0, isAlive: 0 };
  const ops: TabOps = {
    async findExisting() {
      calls.findExisting++;
      if (opts.existing !== undefined) {
        alive.add(opts.existing);
        return opts.existing;
      }
      return undefined;
    },
    async open() {
      calls.open++;
      if (failOpen) {
        failOpen = false;
        throw new Error('open failed');
      }
      const id = nextId++;
      alive.add(id);
      return id;
    },
    async isAlive(id) {
      calls.isAlive++;
      return alive.has(id);
    },
    async close(id) {
      closed.push(id);
      alive.delete(id);
    },
  };
  return { ops, calls, closed, kill: (id: number) => alive.delete(id) };
}

describe('SiteTabPool', () => {
  it('gives concurrent same-site acquires DISTINCT tabs up to the cap', async () => {
    const { ops, calls } = makeFakeOps();
    const pool = new SiteTabPool(ops, 3);

    const leases = await Promise.all([
      pool.acquire('zhihu'),
      pool.acquire('zhihu'),
      pool.acquire('zhihu'),
    ]);
    const ids = leases.map((l) => l.tabId);

    expect(new Set(ids).size).toBe(3); // all different tabs
    expect(calls.open).toBe(3);
    expect(calls.findExisting).toBe(1); // adoption attempted exactly once
    expect(pool.stats('zhihu')).toEqual({ total: 3, free: 0, waiting: 0 });
  });

  it('queues acquires beyond the cap, then hands a freed tab to the waiter', async () => {
    const { ops, calls } = makeFakeOps();
    const pool = new SiteTabPool(ops, 2);

    const l1 = await pool.acquire('zhihu');
    await pool.acquire('zhihu'); // l2 — holds the 2nd (and last) slot

    let resolved = false;
    const p3 = pool.acquire('zhihu').then((l) => {
      resolved = true;
      return l;
    });
    await tick();
    expect(resolved).toBe(false); // cap reached → queued
    expect(pool.stats('zhihu').waiting).toBe(1);

    l1.release();
    const l3 = await p3;
    expect(resolved).toBe(true);
    expect(l3.tabId).toBe(l1.tabId); // reused the freed tab, no new open
    expect(calls.open).toBe(2);
  });

  it('reuses a released tab instead of opening a new one', async () => {
    const { ops, calls } = makeFakeOps();
    const pool = new SiteTabPool(ops, 3);

    const l1 = await pool.acquire('zhihu');
    const firstId = l1.tabId;
    l1.release();
    const l2 = await pool.acquire('zhihu');

    expect(l2.tabId).toBe(firstId);
    expect(calls.open).toBe(1);
  });

  it("adopts the user's existing tab first, then opens new ones", async () => {
    const { ops, calls } = makeFakeOps({ existing: 555 });
    const pool = new SiteTabPool(ops, 3);

    const l1 = await pool.acquire('zhihu', 'zhihu.com');
    expect(l1.tabId).toBe(555); // adopted
    expect(calls.open).toBe(0);

    const l2 = await pool.acquire('zhihu', 'zhihu.com'); // l1 still leased
    expect(l2.tabId).not.toBe(555); // fresh tab
    expect(calls.open).toBe(1);
  });

  it('drops a dead free tab and opens a fresh one', async () => {
    const { ops, calls, kill } = makeFakeOps();
    const pool = new SiteTabPool(ops, 3);

    const l1 = await pool.acquire('zhihu');
    l1.release();
    kill(l1.tabId); // tab closed out from under us while idle

    const l2 = await pool.acquire('zhihu');
    expect(l2.tabId).not.toBe(l1.tabId);
    expect(calls.open).toBe(2);
  });

  it('forget() frees a slot so a queued waiter can open a replacement', async () => {
    const { ops, calls } = makeFakeOps();
    const pool = new SiteTabPool(ops, 1); // cap 1 → easy to saturate

    const l1 = await pool.acquire('zhihu');

    let resolved = false;
    const p2 = pool.acquire('zhihu').then((l) => {
      resolved = true;
      return l;
    });
    await tick();
    expect(resolved).toBe(false); // saturated

    pool.forget(l1.tabId); // user closed the only tab → slot frees
    const l2 = await p2;
    expect(resolved).toBe(true);
    expect(l2.tabId).not.toBe(l1.tabId);
    expect(calls.open).toBe(2);
  });

  it('rejects the waiter when open fails, and recovers on the next acquire', async () => {
    const { ops } = makeFakeOps({ failOpenOnce: true });
    const pool = new SiteTabPool(ops, 3);

    await expect(pool.acquire('zhihu')).rejects.toThrow('open failed');

    const l = await pool.acquire('zhihu'); // failure was one-shot
    expect(typeof l.tabId).toBe('number');
  });

  it('release() is idempotent (double release does not double-free)', async () => {
    const { ops } = makeFakeOps();
    const pool = new SiteTabPool(ops, 3);

    const l1 = await pool.acquire('zhihu');
    l1.release();
    l1.release(); // no-op
    expect(pool.stats('zhihu')).toEqual({ total: 1, free: 1, waiting: 0 });
  });

  it('keeps different sites in independent pools', async () => {
    const { ops, calls } = makeFakeOps();
    const pool = new SiteTabPool(ops, 1);

    const z = await pool.acquire('zhihu');
    const b = await pool.acquire('bilibili'); // different site → not blocked by zhihu's cap
    expect(z.tabId).not.toBe(b.tabId);
    expect(calls.open).toBe(2);
    expect(pool.stats('zhihu').total).toBe(1);
    expect(pool.stats('bilibili').total).toBe(1);
  });

  it('reapCreatedFreeTabs closes free pool-opened tabs, keeps adopted + leased', async () => {
    const { ops, closed } = makeFakeOps({ existing: 555 });
    const pool = new SiteTabPool(ops, 5);

    const l1 = await pool.acquire('zhihu', 'zhihu.com'); // adopt user's 555
    const l2 = await pool.acquire('zhihu', 'zhihu.com'); // pool opens 100
    const l3 = await pool.acquire('zhihu', 'zhihu.com'); // pool opens 101

    // All leased → reaper closes nothing (never touches in-use tabs).
    expect(await pool.reapCreatedFreeTabs()).toBe(0);

    l2.release();
    l3.release();
    l1.release(); // 555 free, but adopted (user's) → must survive

    const n = await pool.reapCreatedFreeTabs();
    expect(n).toBe(2);
    expect(closed.slice().sort((a, b) => a - b)).toEqual([100, 101]);
    expect(closed).not.toContain(555); // user's adopted tab kept
    expect(pool.stats('zhihu')).toEqual({ total: 1, free: 1, waiting: 0 }); // only 555 remains
  });

  it('isLeased: true while leased, false once released or for an unknown id', async () => {
    const { ops } = makeFakeOps();
    const pool = new SiteTabPool(ops, 2);

    const lease = await pool.acquire('zhihu');
    expect(pool.isLeased(lease.tabId)).toBe(true);
    expect(pool.isLeased(999)).toBe(false); // not managed by any pool

    lease.release();
    await tick();
    expect(pool.isLeased(lease.tabId)).toBe(false); // back in the free list → not leased
  });
});
