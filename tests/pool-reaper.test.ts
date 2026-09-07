/**
 * Durable site-pool reaper (src/tools/pool-reaper.ts) — the half of the pool
 * that has to outlive the service worker. Verifies the two passes (in-memory
 * free-created tabs, then the storage.session mirror that catches tabs orphaned
 * by an SW restart), that a LEASED tab is spared, that adopted user tabs are
 * never touched, and that the mirror is emptied as it goes.
 *
 * Extracted from tools/dispatcher.ts when localmd Connect's own pool turned out
 * to have no reaper at all (§10.48) — one implementation, two shells.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SiteTabPool, type TabOps } from '../src/tools/site-tab-pool';
import { createPoolReaper } from '../src/tools/pool-reaper';

const KEY = 'test:poolCreatedTabs';

function makeChrome() {
  const store: Record<string, unknown> = {};
  const openTabs = new Set<number>();
  const removed: number[] = [];
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
    tabs: {
      get: async (id: number) => {
        if (!openTabs.has(id)) throw new Error('No tab with id');
        return { id };
      },
      remove: async (id: number) => {
        if (!openTabs.delete(id)) throw new Error('No tab with id');
        removed.push(id);
      },
    },
  });
  return { store, openTabs, removed };
}

/** A pool whose tabs are plain increasing ids; `adopt` seeds a user tab the
 *  pool will adopt on first use instead of opening its own. */
function makePool(env: ReturnType<typeof makeChrome>, adopt?: number) {
  let next = 1;
  const ops: TabOps = {
    findExisting: async () => adopt,
    open: async () => {
      const id = 100 + next++;
      env.openTabs.add(id);
      return id;
    },
    isAlive: async (id) => env.openTabs.has(id),
    close: async (id) => {
      if (env.openTabs.delete(id)) env.removed.push(id);
    },
  };
  if (adopt !== undefined) env.openTabs.add(adopt);
  return new SiteTabPool(ops, 5);
}

let env: ReturnType<typeof makeChrome>;

beforeEach(() => {
  env = makeChrome();
});

describe('pool reaper', () => {
  it('closes a free pool-opened tab and empties its record', async () => {
    const pool = makePool(env);
    const reaper = createPoolReaper(pool, KEY);
    const lease = await pool.acquire('zhihu');
    await reaper.note(lease.tabId);
    lease.release();

    expect(await reaper.reap()).toBe(1);
    expect(env.removed).toEqual([lease.tabId]);
    expect(env.store[KEY]).toEqual([]);
  });

  it('spares a tab that is currently leased', async () => {
    const pool = makePool(env);
    const reaper = createPoolReaper(pool, KEY);
    const lease = await pool.acquire('zhihu');
    await reaper.note(lease.tabId);
    // Still in flight — an external call is mid-execution on it.
    expect(await reaper.reap()).toBe(0);
    expect(env.removed).toEqual([]);
    // …and once released it goes.
    lease.release();
    expect(await reaper.reap()).toBe(1);
  });

  it('never closes a tab the pool adopted from the user', async () => {
    const pool = makePool(env, 42);
    const reaper = createPoolReaper(pool, KEY);
    const lease = await pool.acquire('zhihu');
    expect(lease.tabId).toBe(42); // adopted, so tabOps.open never ran → never noted
    lease.release();

    expect(await reaper.reap()).toBe(0);
    expect(env.openTabs.has(42)).toBe(true);
  });

  it('collects tabs the pool forgot across an SW restart', async () => {
    const first = makePool(env);
    const reaper1 = createPoolReaper(first, KEY);
    const lease = await first.acquire('zhihu');
    await reaper1.note(lease.tabId);
    lease.release();

    // MV3 recycles the worker: fresh pool + fresh reaper, same storage.session.
    // The new pool has no idea it ever created that tab; the mirror does.
    const second = makePool(env);
    const reaper2 = createPoolReaper(second, KEY);
    expect(await reaper2.reap()).toBe(1);
    expect(env.removed).toEqual([lease.tabId]);
    expect(env.store[KEY]).toEqual([]);
  });

  it('drops a record whose tab the user already closed, without counting it', async () => {
    const pool = makePool(env);
    const reaper = createPoolReaper(pool, KEY);
    await reaper.note(999); // never opened here — stands in for a pre-restart id
    env.openTabs.delete(999);

    expect(await reaper.reap()).toBe(0);
    expect(env.store[KEY]).toEqual([]);
  });

  it('keeps parallel opens from clobbering each other', async () => {
    const pool = makePool(env);
    const reaper = createPoolReaper(pool, KEY);
    // The pool opens tabs concurrently; unchained read-modify-write would drop
    // ids, and a dropped id is a tab nothing can ever reap.
    await Promise.all([1, 2, 3, 4, 5].map((id) => reaper.note(id)));
    expect(env.store[KEY]).toEqual([1, 2, 3, 4, 5]);
  });

  it('forgets a tab on close so a later reap does not chase it', async () => {
    const pool = makePool(env);
    const reaper = createPoolReaper(pool, KEY);
    await reaper.note(7);
    await reaper.forget(7);
    expect(env.store[KEY]).toEqual([]);
  });
});
