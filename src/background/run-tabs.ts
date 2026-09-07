/**
 * Run-tab janitor — deterministic "clear tabs" at task end.
 *
 * `generic__open_url` opens tabs in the agent window and (before this module)
 * relied on the MODEL remembering to `close_tab` when the task finished — which
 * it chronically forgot, so tabs piled up. The site-tab POOL already self-reaps
 * (dispatcher reapPoolTabs), but open_url tabs were nobody's responsibility.
 * Now the harness owns it: the dispatcher records every tab open_url creates,
 * keyed by the run's origin (sessionId), and the engine driver closes them —
 * the model doesn't have to remember anything.
 *
 * Two tab classes, two lifecycles (session s_mregtz8u: "why aren't they cleared on finish"):
 *  - BACKGROUND opens (work tabs): reaped when their run finishes.
 *  - ACTIVE opens (display pages — the agent deliberately showed the user a page, e.g.
 *    "open it and take a look"): they must survive their own run (the user is reading them
 *    right as the run ends), so they're recorded as `shown` and recycled when
 *    the NEXT run of the same session starts (rotateShownTabs → prevShown →
 *    reaped at that run's end). The user has come back and asked for something
 *    new — the viewing moment is over.
 *
 * The only spare rule at reap time is "BEING VIEWED": the tab is active IN THE
 * FOCUSED window. Plain `tab.active` is NOT enough — in the background agent
 * window the last activated tab stays .active forever, which under the v1 rule
 * permanently exempted every display-page/takeover tab (the exact leak the user hit).
 * A spared viewed display page stays recorded and is collected on a later pass.
 *
 * Other exclusions: a `checkpoint` finish keeps its tabs (the "continue" turn
 * reuses them; its record clock is touched instead), the explore tab
 * (explore-driver owns it), and bridge/verify origins (external agents own
 * their tabs' lifecycle) are never recorded.
 *
 * Records mirror to storage.session (same lifetime pattern as the dispatcher's
 * durable pool-tab set) so tabs opened before an MV3 SW restart are still
 * collected by the stale sweep instead of leaking forever.
 */

import { log } from '@base/runtime/log';

const RUN_TABS_KEY = 'web:runOpenedTabs';

/** A checkpointed / crashed session's tabs are collected once its record is
 * this old and no run is active — long enough that a genuinely-parked "send continue"
 * session isn't yanked, short enough that leaks don't outlive a work session. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface RunTabRecord {
  /** Background work tabs — reaped at this run's end. */
  tabs: number[];
  /** Display pages opened THIS run (active:true) — survive their own run's reap. */
  shown: number[];
  /** Display pages from PREVIOUS runs (rotated at run start) — reaped at run end. */
  prevShown: number[];
  /** Last touch (record / checkpoint) — the stale sweep's clock. */
  ts: number;
}

type RunTabStore = Record<string, RunTabRecord>;

function emptyRecord(): RunTabRecord {
  return { tabs: [], shown: [], prevShown: [], ts: 0 };
}

async function loadStore(): Promise<RunTabStore> {
  try {
    const got = await chrome.storage?.session?.get(RUN_TABS_KEY);
    const v = (got as Record<string, unknown>)?.[RUN_TABS_KEY];
    if (!v || typeof v !== 'object') return {};
    const out: RunTabStore = {};
    for (const [origin, rec] of Object.entries(v as Record<string, unknown>)) {
      const r = rec as Partial<RunTabRecord>;
      if (!Array.isArray(r.tabs) && !Array.isArray(r.shown) && !Array.isArray(r.prevShown))
        continue;
      const nums = (a: unknown): number[] =>
        Array.isArray(a) ? a.filter((t): t is number => typeof t === 'number') : [];
      out[origin] = {
        tabs: nums(r.tabs),
        shown: nums(r.shown),
        prevShown: nums(r.prevShown),
        ts: typeof r.ts === 'number' ? r.ts : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// Single-writer chain: open_url calls run in PARALLEL (one turn can fan out
// several), so unchained read-modify-write cycles would clobber each other and
// drop tab ids — exactly the un-reapable-orphan failure this store prevents.
// Same pattern as the dispatcher's pool-tab set.
let writeChain: Promise<void> = Promise.resolve();
function mutateStore(mutate: (cur: RunTabStore) => RunTabStore | null): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      const cur = await loadStore();
      const next = mutate(cur);
      if (next) await chrome.storage.session.set({ [RUN_TABS_KEY]: next });
    } catch {
      /* storage.session unavailable → reaping degrades gracefully */
    }
  });
  return writeChain;
}

/** Record a tab that `open_url` created for this run. `userFacing` = opened
 * with active:true (a display page) — it survives its own run's reap. Call only for
 * agent-session origins with a real (non-explore) new tab. */
export function recordRunTab(
  origin: string,
  tabId: number,
  opts: { userFacing?: boolean } = {},
): Promise<void> {
  return mutateStore((cur) => {
    const rec = cur[origin] ?? emptyRecord();
    if (rec.tabs.includes(tabId) || rec.shown.includes(tabId) || rec.prevShown.includes(tabId)) {
      return null;
    }
    const next = { ...rec, ts: Date.now() };
    if (opts.userFacing) next.shown = [...rec.shown, tabId];
    else next.tabs = [...rec.tabs, tabId];
    return { ...cur, [origin]: next };
  });
}

/** Call at RUN START: last run's display pages become reap-eligible (prevShown) —
 * the user came back and asked for something new, the viewing moment is over.
 * Tabs shown by the run about to start will land in a fresh `shown`. */
export function rotateShownTabs(origin: string): Promise<void> {
  return mutateStore((cur) => {
    const rec = cur[origin];
    if (!rec || rec.shown.length === 0) return null;
    return {
      ...cur,
      [origin]: { ...rec, shown: [], prevShown: [...rec.prevShown, ...rec.shown] },
    };
  });
}

/** Refresh a run's record clock without reaping — used on a `checkpoint` finish
 * so the stale sweep gives the parked session a fresh grace period. */
export function touchRunTabs(origin: string): Promise<void> {
  return mutateStore((cur) =>
    cur[origin] ? { ...cur, [origin]: { ...cur[origin], ts: Date.now() } } : null,
  );
}

/** The window the user is actually looking at, or undefined. */
async function focusedWindowId(): Promise<number | undefined> {
  try {
    const w = await chrome.windows.getLastFocused();
    return w?.focused && typeof w.id === 'number' ? w.id : undefined;
  } catch {
    return undefined;
  }
}

/** Close one recorded tab unless the user is LOOKING at it right now (active
 * tab of the focused window — NOT mere tab.active, see file header). */
async function closeUnlessViewed(
  tabId: number,
  focusedWin: number | undefined,
): Promise<'closed' | 'viewed' | 'gone'> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  }
  if (tab.active && focusedWin !== undefined && tab.windowId === focusedWin) return 'viewed';
  try {
    await chrome.tabs.remove(tabId);
    return 'closed';
  } catch {
    return 'gone'; // raced with another close — fine
  }
}

/** RUN-END reap for `origin`: close its background tabs + previous runs' display
 * pages (a currently-VIEWED display page is kept recorded for a later pass; a viewed
 * work tab is forgotten — the user claimed it). This run's own `shown` tabs survive.
 * Returns the number actually closed. */
export async function reapRunTabs(origin: string): Promise<number> {
  const store = await loadStore();
  const rec = store[origin];
  if (!rec) return 0;
  const focusedWin = await focusedWindowId();
  let closed = 0;
  const keptPrevShown: number[] = [];
  for (const id of rec.tabs) {
    if ((await closeUnlessViewed(id, focusedWin)) === 'closed') closed++;
  }
  for (const id of rec.prevShown) {
    const r = await closeUnlessViewed(id, focusedWin);
    if (r === 'closed') closed++;
    else if (r === 'viewed') keptPrevShown.push(id);
  }
  await mutateStore((cur) => {
    const c = cur[origin];
    if (!c) return null;
    // Keep this run's display pages (+ any still-viewed older one); drop the rest. Tabs
    // recorded by a raced parallel writer since our snapshot stay via `c`.
    const tabs = c.tabs.filter((t) => !rec.tabs.includes(t));
    const shown = c.shown;
    const prevShown = c.prevShown.filter(
      (t) => keptPrevShown.includes(t) || !rec.prevShown.includes(t),
    );
    if (!tabs.length && !shown.length && !prevShown.length) {
      const next = { ...cur };
      delete next[origin];
      return next;
    }
    return { ...cur, [origin]: { tabs, shown, prevShown, ts: Date.now() } };
  });
  if (closed) log('run-tabs', `reaped ${closed} tab(s) for ${origin}`);
  return closed;
}

/** Collect records left behind by checkpointed-then-abandoned sessions and SW
 * restarts — closes EVERYTHING recorded for stale origins, display pages included
 * (still sparing a tab the user is looking at). Call when NO run is active;
 * only records older than the grace period are touched. */
export async function sweepStaleRunTabs(now = Date.now()): Promise<number> {
  const store = await loadStore();
  const focusedWin = await focusedWindowId();
  let closed = 0;
  for (const [origin, rec] of Object.entries(store)) {
    if (now - rec.ts < STALE_AFTER_MS) continue;
    for (const id of [...rec.tabs, ...rec.shown, ...rec.prevShown]) {
      if ((await closeUnlessViewed(id, focusedWin)) === 'closed') closed++;
    }
    await mutateStore((cur) => {
      if (!(origin in cur)) return null;
      const next = { ...cur };
      delete next[origin]; // abandoned session — a spared viewed tab is the user's now
      return next;
    });
  }
  if (closed) log('run-tabs', `stale sweep reaped ${closed} tab(s)`);
  return closed;
}

/** Test-only: reset the write chain between cases. */
export function __resetRunTabs(): void {
  writeChain = Promise.resolve();
}
