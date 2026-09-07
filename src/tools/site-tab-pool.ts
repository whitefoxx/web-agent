/**
 * Per-site tab pool — parallel-execution v3 (see docs/parallel-execution.md §8).
 *
 * Before v3, every site adapter shared ONE per-site tab (`ensureSiteTab`) and the
 * dispatcher serialized same-site calls with a coarse `site:<site>` lock so two
 * calls could never attach CDP to that one tab at once. Correct, but it made
 * independent same-site work (e.g. fetch 3 zhihu answers) strictly serial.
 *
 * v3 replaces the single shared tab + lock with a bounded POOL of tabs per site:
 *   - `acquire()` leases an EXCLUSIVE tab — reusing a free one, adopting the
 *     user's already-open tab on first use, or opening a new background tab up to
 *     `maxPerSite`.
 *   - `release()` returns it (handed straight to the next waiter, else recycled).
 * Concurrent same-site calls get DIFFERENT tabs and run in parallel up to the
 * cap; beyond the cap they queue. Each lease is exclusive, so no two calls ever
 * share a tab — the safety invariant the old lock gave us, now without forcing
 * serialization.
 *
 * Chrome specifics live behind `TabOps` so the queueing core is unit-testable
 * with a fake (see tests/site-tab-pool.test.ts).
 */

export interface TabOps {
  /** Find an already-open tab for this site to adopt (the user's own tab), or
   *  undefined. Called at most once per site (first allocation). */
  findExisting(site: string, domain?: string): Promise<number | undefined>;
  /** Open a fresh background tab for this site; resolve when it's ready. */
  open(site: string, domain?: string): Promise<number>;
  /** Is this tab still open? Free tabs are re-validated before reuse. */
  isAlive(tabId: number): Promise<boolean>;
  /** Close a tab the pool opened (used by the idle reaper). */
  close(tabId: number): Promise<void>;
}

export interface TabLease {
  readonly tabId: number;
  /** Return the tab to the pool (idempotent). */
  release(): void;
}

interface Waiter {
  resolve: (lease: TabLease) => void;
  reject: (err: unknown) => void;
}

interface PoolState {
  domain?: string;
  /** Every tab this pool manages (leased or free). */
  all: Set<number>;
  /** Tabs the pool itself OPENED (vs. adopted from the user). Only these are
   *  closed by the reaper — never the user's own tabs. Subset of `all`. */
  created: Set<number>;
  /** Available (not-leased) tabs, FIFO. */
  free: number[];
  /** Queued acquirers waiting for a tab. */
  waiters: Waiter[];
  /** Whether we've already tried to adopt the user's existing tab. */
  adopted: boolean;
  /** Single-flight guard for pump(); `dirty` re-runs it if work arrived
   *  while an await was in flight. */
  pumping: boolean;
  dirty: boolean;
}

export class SiteTabPool {
  private pools = new Map<string, PoolState>();

  constructor(
    private ops: TabOps,
    private maxPerSite: number,
  ) {}

  /** Lease an exclusive tab for `site`. Resolves as soon as capacity is
   *  available, otherwise queues until a tab frees up. `site` should already be
   *  namespace-stripped (baseSite) by the caller so explored + installed
   *  adapters share one pool. */
  acquire(site: string, domain?: string): Promise<TabLease> {
    const pool = this.ensurePool(site, domain);
    return new Promise<TabLease>((resolve, reject) => {
      pool.waiters.push({ resolve, reject });
      void this.pump(site);
    });
  }

  /** Drop a closed tab from every pool (wire to chrome.tabs.onRemoved). Frees a
   *  slot so a queued waiter can open a replacement. */
  forget(tabId: number): void {
    for (const [site, pool] of this.pools) {
      const had = pool.all.delete(tabId);
      pool.created.delete(tabId);
      const i = pool.free.indexOf(tabId);
      if (i >= 0) pool.free.splice(i, 1);
      if (had) void this.pump(site);
    }
  }

  /** Close pool-OPENED tabs that are currently free (not leased), keeping the
   *  user's adopted tabs and any in-use lease. Call when all work is idle so
   *  agent-opened site tabs don't pile up after a task; the pool re-warms on the
   *  next same-site call. Returns the number closed. */
  async reapCreatedFreeTabs(): Promise<number> {
    let closed = 0;
    for (const [, pool] of this.pools) {
      // Snapshot: ops.close → onRemoved → forget() may mutate pool.free mid-loop.
      for (const id of [...pool.free]) {
        if (!pool.created.has(id)) continue; // adopted/user tab — leave it
        // Drop from tracking BEFORE awaiting close so the forget() it triggers
        // is a no-op.
        pool.all.delete(id);
        pool.created.delete(id);
        const fi = pool.free.indexOf(id);
        if (fi >= 0) pool.free.splice(fi, 1);
        try {
          await this.ops.close(id);
          closed++;
        } catch {
          /* already gone — fine */
        }
      }
    }
    return closed;
  }

  /** Is this tab currently LEASED (managed by some pool but not in its free list)?
   * Used by the durable orphan-reaper to spare in-flight tabs (e.g. a bridge call
   * mid-execution) while closing everything else it created. A tab unknown to
   * every live pool returns false (it's not leased here — typically a pre-restart
   * orphan the in-memory pools no longer track). */
  isLeased(tabId: number): boolean {
    for (const [, pool] of this.pools) {
      if (pool.all.has(tabId) && !pool.free.includes(tabId)) return true;
    }
    return false;
  }

  /** Diagnostics: managed / free / waiting counts for a site. */
  stats(site: string): { total: number; free: number; waiting: number } {
    const p = this.pools.get(site);
    return {
      total: p?.all.size ?? 0,
      free: p?.free.length ?? 0,
      waiting: p?.waiters.length ?? 0,
    };
  }

  private ensurePool(site: string, domain?: string): PoolState {
    let pool = this.pools.get(site);
    if (!pool) {
      pool = {
        domain,
        all: new Set(),
        created: new Set(),
        free: [],
        waiters: [],
        adopted: false,
        pumping: false,
        dirty: false,
      };
      this.pools.set(site, pool);
    } else if (domain && !pool.domain) {
      pool.domain = domain;
    }
    return pool;
  }

  /** Single-flight allocator: hand free/new tabs to queued waiters until either
   *  no waiters remain or capacity is exhausted. Re-runs if work arrived while
   *  an await was in flight (`dirty`). Being single-flight makes the capacity
   *  checks in takeOrCreate race-free. */
  private async pump(site: string): Promise<void> {
    const pool = this.pools.get(site);
    if (!pool) return;
    if (pool.pumping) {
      pool.dirty = true;
      return;
    }
    pool.pumping = true;
    try {
      do {
        pool.dirty = false;
        while (pool.waiters.length > 0) {
          let tabId: number | undefined;
          try {
            tabId = await this.takeOrCreate(pool, site);
          } catch (e) {
            // Allocation failed (e.g. tab-open timeout) — fail one waiter and
            // keep going; capacity may free for the rest.
            pool.waiters.shift()?.reject(e);
            continue;
          }
          if (tabId === undefined) break; // at capacity → wait for a release/forget
          const waiter = pool.waiters.shift();
          if (!waiter) {
            pool.free.push(tabId); // no taker (shouldn't happen) — recycle
            break;
          }
          waiter.resolve(this.makeLease(site, tabId));
        }
      } while (pool.dirty);
    } finally {
      pool.pumping = false;
    }
  }

  /** Reuse a live free tab, else adopt the user's existing tab once, else open a
   *  new tab under the cap. Returns undefined when every managed tab is leased
   *  and the cap is reached (caller waits). Only ever called inside pump's
   *  single-flight, so the capacity arithmetic can't race. */
  private async takeOrCreate(pool: PoolState, site: string): Promise<number | undefined> {
    while (pool.free.length > 0) {
      const id = pool.free.shift()!;
      if (await this.ops.isAlive(id)) return id;
      pool.all.delete(id); // stale → drop and try the next
      pool.created.delete(id);
    }
    if (pool.all.size === 0 && !pool.adopted) {
      pool.adopted = true;
      const adopted = await this.ops.findExisting(site, pool.domain);
      if (adopted !== undefined) {
        pool.all.add(adopted); // adopted (user) tab — NOT added to `created`
        return adopted;
      }
    }
    if (pool.all.size < this.maxPerSite) {
      const id = await this.ops.open(site, pool.domain);
      pool.all.add(id);
      pool.created.add(id); // pool-opened → reapable when idle
      return id;
    }
    return undefined;
  }

  private makeLease(site: string, tabId: number): TabLease {
    let released = false;
    return {
      tabId,
      release: () => {
        if (released) return;
        released = true;
        const pool = this.pools.get(site);
        if (!pool) return;
        // If the tab was closed while leased (forgotten), don't recycle a dead
        // tab; pump() will open a replacement for any waiter (the slot is free).
        if (pool.all.has(tabId)) pool.free.push(tabId);
        void this.pump(site);
      },
    };
  }
}
