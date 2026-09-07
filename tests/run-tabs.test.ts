/**
 * Run-tab janitor (src/background/run-tabs.ts): deterministic "clear tabs" at
 * task end — background open_url tabs reap at run end; ACTIVE-opened 展示页
 * survive their own run and are recycled after the NEXT run (rotate → prevShown
 * → reap). The only spare rule is BEING VIEWED = active tab of the FOCUSED
 * window (mere tab.active in a background agent window must NOT exempt — that
 * was the v1 leak, session s_mregtz8u). Minimal chrome stub (storage.session +
 * tabs.get/remove + windows.getLastFocused).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRunTab,
  rotateShownTabs,
  touchRunTabs,
  reapRunTabs,
  sweepStaleRunTabs,
  __resetRunTabs,
} from '../src/background/run-tabs';

const KEY = 'web:runOpenedTabs';

function makeChrome() {
  const store: Record<string, unknown> = {};
  const tabs = new Map<number, { id: number; active: boolean; windowId: number }>();
  const removed: number[] = [];
  const env = {
    store,
    tabs,
    removed,
    /** The window the user is looking at (getLastFocused). */
    focusedWindowId: 1,
    addTab(id: number, opts: { active?: boolean; windowId?: number } = {}) {
      tabs.set(id, { id, active: !!opts.active, windowId: opts.windowId ?? 2 });
    },
  };
  (globalThis as { chrome?: unknown }).chrome = {
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
        const t = tabs.get(id);
        if (!t) throw new Error('No tab with id');
        return t;
      },
      remove: async (id: number) => {
        if (!tabs.has(id)) throw new Error('No tab with id');
        tabs.delete(id);
        removed.push(id);
      },
    },
    windows: {
      getLastFocused: async () => ({ id: env.focusedWindowId, focused: true }),
    },
  };
  return env;
}

let env: ReturnType<typeof makeChrome>;

beforeEach(() => {
  __resetRunTabs();
  env = makeChrome();
});

describe('run-tabs janitor — background tabs', () => {
  it('records per origin and reaps only that origin, clearing its record', async () => {
    env.addTab(11);
    env.addTab(12);
    env.addTab(21);
    await recordRunTab('s_a', 11);
    await recordRunTab('s_a', 12);
    await recordRunTab('s_b', 21);

    expect(await reapRunTabs('s_a')).toBe(2);
    expect(env.removed.sort()).toEqual([11, 12]);
    expect(env.tabs.has(21)).toBe(true); // other origin untouched
    expect(await reapRunTabs('s_a')).toBe(0); // record cleared
  });

  it('tab.active in an UNFOCUSED window does NOT spare (the v1 agent-window leak)', async () => {
    env.addTab(11, { active: true, windowId: 9 }); // agent window, not focused
    await recordRunTab('s_a', 11);
    expect(await reapRunTabs('s_a')).toBe(1);
    expect(env.tabs.has(11)).toBe(false);
  });

  it('spares (and forgets) a tab the user is VIEWING: active in the focused window', async () => {
    env.addTab(11, { active: true, windowId: 1 }); // focused window
    env.addTab(12);
    await recordRunTab('s_a', 11);
    await recordRunTab('s_a', 12);
    expect(await reapRunTabs('s_a')).toBe(1);
    expect(env.tabs.has(11)).toBe(true); // spared — the user claimed it
    env.tabs.get(11)!.active = false;
    expect(await reapRunTabs('s_a')).toBe(0); // forgotten, never touched again
    expect(env.tabs.has(11)).toBe(true);
  });

  it('tolerates already-closed tabs and unknown origins', async () => {
    env.addTab(11);
    await recordRunTab('s_a', 11);
    env.tabs.delete(11);
    expect(await reapRunTabs('s_a')).toBe(0);
    expect(await reapRunTabs('s_never')).toBe(0);
  });
});

describe('run-tabs janitor — 展示页 (userFacing) lifecycle', () => {
  it('survives its own run-end reap, gets collected after the next rotate+reap', async () => {
    env.addTab(31, { active: true, windowId: 9 }); // shown in the agent window
    await recordRunTab('s_a', 31, { userFacing: true });

    // Run 1 ends: 展示页 spared (user reading it right now).
    expect(await reapRunTabs('s_a')).toBe(0);
    expect(env.tabs.has(31)).toBe(true);

    // Run 2 starts (user came back with a new ask) → rotate; run 2 ends → reaped.
    await rotateShownTabs('s_a');
    expect(await reapRunTabs('s_a')).toBe(1);
    expect(env.tabs.has(31)).toBe(false);
  });

  it('a rotated 展示页 the user is STILL viewing stays recorded and is collected later', async () => {
    env.addTab(31, { active: true, windowId: 1 }); // focused window — being read
    await recordRunTab('s_a', 31, { userFacing: true });
    await rotateShownTabs('s_a');

    expect(await reapRunTabs('s_a')).toBe(0); // viewed → spared, kept recorded
    expect(env.tabs.has(31)).toBe(true);

    env.tabs.get(31)!.active = false; // user moved on
    expect(await reapRunTabs('s_a')).toBe(1); // collected on the next pass
    expect(env.tabs.has(31)).toBe(false);
  });

  it('new shown tabs recorded between rotate and reap are kept', async () => {
    env.addTab(31, { active: true, windowId: 9 });
    env.addTab(32, { active: true, windowId: 9 });
    await recordRunTab('s_a', 31, { userFacing: true });
    await rotateShownTabs('s_a'); // run 2 starts
    await recordRunTab('s_a', 32, { userFacing: true }); // run 2 shows a new page

    expect(await reapRunTabs('s_a')).toBe(1); // 31 collected
    expect(env.tabs.has(31)).toBe(false);
    expect(env.tabs.has(32)).toBe(true); // run 2's own 展示页 survives
  });
});

describe('run-tabs janitor — stale sweep', () => {
  it('collects everything (shown included) past the grace period; touch renews', async () => {
    env.addTab(11);
    env.addTab(31, { active: true, windowId: 9 });
    env.addTab(21);
    env.store[KEY] = {
      s_old: { tabs: [11], shown: [31], prevShown: [], ts: Date.now() - 7 * 60 * 60 * 1000 },
      s_new: { tabs: [21], shown: [], prevShown: [], ts: Date.now() },
    };
    expect(await sweepStaleRunTabs()).toBe(2);
    expect(env.tabs.has(11)).toBe(false);
    expect(env.tabs.has(31)).toBe(false);
    expect(env.tabs.has(21)).toBe(true);

    env.store[KEY] = {
      s_parked: { tabs: [21], shown: [], prevShown: [], ts: Date.now() - 7 * 60 * 60 * 1000 },
    };
    await touchRunTabs('s_parked');
    expect(await sweepStaleRunTabs()).toBe(0);
    expect(env.tabs.has(21)).toBe(true);
  });

  it('tolerates the legacy record shape (tabs-only, no shown/prevShown)', async () => {
    env.addTab(11);
    env.store[KEY] = { s_legacy: { tabs: [11], ts: 0 } };
    expect(await sweepStaleRunTabs()).toBe(1);
    expect(env.tabs.has(11)).toBe(false);
  });
});

describe('run-tabs janitor — concurrency', () => {
  it('parallel records for one origin never clobber each other (write chain)', async () => {
    for (let i = 0; i < 10; i++) env.addTab(100 + i);
    await Promise.all(Array.from({ length: 10 }, (_, i) => recordRunTab('s_par', 100 + i)));
    expect(await reapRunTabs('s_par')).toBe(10);
  });
});
