/**
 * Durable reaper for site-pool tabs — the half of a `SiteTabPool` that has to
 * outlive the service worker.
 *
 * The pool's own `created` set is in memory, and MV3 recycles the worker
 * whenever it feels like it. Every tab opened before a restart is then an orphan
 * the pool no longer knows it created, so a long session accumulates them until
 * the browser closes. Mirroring the ids into `storage.session` (the same
 * lifetime as the agent window's id) is what lets a later reap still find them.
 *
 * Only tabs the pool OPENED are recorded here — never a tab it adopted from the
 * user, never an `open_url` or explore tab — so reaping from this set cannot
 * close something the user wanted kept.
 *
 * Written once, used by both executors that own a pool: the full shell's
 * dispatcher and localmd Connect's adapter executor. The second one is why this
 * is a module rather than a block inside the first: localmd Connect ran without
 * a reaper at all, and its site tabs piled up for exactly the reason described
 * above — a second hand-rolled copy would have been a second thing to keep in
 * step.
 */

import type { SiteTabPool } from './site-tab-pool';

export interface PoolReaper {
  /** Record a tab the pool just opened. Call from `TabOps.open`. */
  note(tabId: number): Promise<void>;
  /** Drop a tab that is gone. Call from `chrome.tabs.onRemoved`. */
  forget(tabId: number): Promise<void>;
  /**
   * Close idle (free, pool-opened) site tabs — call when all work is done so
   * background tabs don't pile up. Never closes the user's own/adopted tabs or
   * an in-use lease. Two passes: the pool's in-memory free-created tabs, then a
   * durable pass over `storage.session` that catches tabs orphaned by an SW
   * restart. Returns the number closed.
   */
  reap(): Promise<number>;
}

export function createPoolReaper(pool: SiteTabPool, storageKey: string): PoolReaper {
  async function load(): Promise<number[]> {
    try {
      const got = await chrome.storage?.session?.get(storageKey);
      const v = (got as Record<string, unknown>)?.[storageKey];
      return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    } catch {
      return [];
    }
  }

  // Serialize every mutation behind a single-writer promise chain. The pool
  // opens tabs in PARALLEL (≤5/site, concurrently across sites), so unchained
  // read-modify-write cycles would read the same snapshot and clobber each other
  // — dropping ids → un-reapable orphan tabs, the exact failure this set exists
  // to prevent. onRemoved's remove compounds it. Chaining makes each mutation
  // observe the prior one's write. `mutate` returns the SAME array ref when
  // nothing changed, so a redundant write is skipped. Errors are swallowed
  // inside the link so the chain never poisons.
  let writeChain: Promise<void> = Promise.resolve();
  function mutate(fn: (cur: number[]) => number[]): Promise<void> {
    writeChain = writeChain.then(async () => {
      try {
        const cur = await load();
        const next = fn(cur);
        if (next !== cur) await chrome.storage.session.set({ [storageKey]: next });
      } catch {
        /* storage.session unavailable → orphan-reap degrades to in-memory only */
      }
    });
    return writeChain;
  }

  return {
    note: (tabId) => mutate((cur) => (cur.includes(tabId) ? cur : [...cur, tabId])),
    forget: (tabId) => mutate((cur) => (cur.includes(tabId) ? cur.filter((x) => x !== tabId) : cur)),
    async reap() {
      let closed = await pool.reapCreatedFreeTabs();
      for (const id of await load()) {
        if (pool.isLeased(id)) continue; // in use (e.g. a bridge call) — leave it
        let open = false;
        try {
          await chrome.tabs.get(id);
          open = true;
        } catch {
          /* already gone */
        }
        if (open) {
          try {
            await chrome.tabs.remove(id);
            closed++;
          } catch {
            /* raced with another close — fine */
          }
        }
        await mutate((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur));
      }
      return closed;
    },
  };
}
