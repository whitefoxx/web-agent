/**
 * syncAllAlarms — SW-boot reconciliation for scheduled tasks. MV3 recycles the
 * SW constantly and alarms PERSIST across restarts, so boot must CREATE-IF-ABSENT,
 * never clear+recreate (which would push every interval alarm's next fire to
 * now+period on each boot → it'd nearly never fire). See schedule-runner §10.28.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Schedule } from '../src/schedules/store';
import { syncAllAlarms, handleScheduleAlarm } from '../src/background/schedule-runner';

function sched(id: string, enabled: boolean): Schedule {
  return {
    id,
    label: id,
    prompt: 'do X',
    cadence: { kind: 'interval', minutes: 60 },
    enabled,
    createdAt: 0,
  };
}

function stubChrome(schedules: Schedule[], existingAlarmNames: string[]) {
  const alarms = new Map<string, { name: string; when?: number }>();
  for (const n of existingAlarmNames) alarms.set(n, { name: n, when: 111 });
  const calls = { create: [] as string[], clear: [] as string[] };
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ schedules }) } },
    alarms: {
      get: async (name: string) => alarms.get(name),
      create: async (name: string, info: { when?: number }) => {
        calls.create.push(name);
        alarms.set(name, { name, ...info });
      },
      clear: async (name: string) => {
        calls.clear.push(name);
        return alarms.delete(name);
      },
    },
  });
  return { alarms, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('syncAllAlarms — boot reconciliation', () => {
  it('does NOT reset an existing interval alarm (fixes the every-boot drift)', async () => {
    const { alarms, calls } = stubChrome([sched('a', true)], ['schedule:a']);
    await syncAllAlarms();
    expect(calls.create).toEqual([]); // existing alarm left ticking
    expect(alarms.get('schedule:a')?.when).toBe(111); // its next-fire preserved
  });

  it('creates only the MISSING alarm', async () => {
    const { calls } = stubChrome([sched('a', true), sched('b', true)], ['schedule:a']);
    await syncAllAlarms();
    expect(calls.create).toEqual(['schedule:b']);
  });

  it('clears the alarm of a disabled schedule', async () => {
    const { alarms, calls } = stubChrome([sched('c', false)], ['schedule:c']);
    await syncAllAlarms();
    expect(calls.clear).toContain('schedule:c');
    expect(alarms.has('schedule:c')).toBe(false);
  });
});

/** Richer stub for the alarm-fire path: storage get+set (the runner writes the
 * schedule row + notices), alarms create. IDB is absent in node so session
 * writes no-op; the prompt run fails fast (no model configured), which is fine
 * — these tests assert the RE-ARM / RETIRE bookkeeping, not the run itself. */
function stubChromeRW(schedules: Schedule[]) {
  const store: Record<string, unknown> = { schedules };
  const created: Array<{ name: string; info: { when?: number; periodInMinutes?: number } }> = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => ({ ...store }),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
    alarms: {
      get: async () => undefined,
      create: async (name: string, info: { when?: number }) => {
        created.push({ name, info });
      },
      clear: async () => true,
    },
  });
  return { store, created };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe('handleScheduleAlarm — one-shot cadences', () => {
  it('weekly: re-arms the next occurrence (absolute when, no period)', async () => {
    const s: Schedule = {
      ...sched('w1', true),
      cadence: { kind: 'weekly', days: [1, 5], hour: 8, minute: 0 },
    };
    const { created } = stubChromeRW([s]);
    await handleScheduleAlarm('schedule:w1');
    await settle();
    const rearm = created.find((c) => c.name === 'schedule:w1');
    expect(rearm).toBeTruthy();
    expect(rearm!.info.periodInMinutes).toBeUndefined();
    expect(rearm!.info.when).toBeGreaterThan(Date.now() - 1000);
  });

  it('once: retires the schedule (enabled=false) after its single fire', async () => {
    const s: Schedule = {
      ...sched('o1', true),
      cadence: { kind: 'once', at: Date.now() - 1000 },
    };
    const { store, created } = stubChromeRW([s]);
    await handleScheduleAlarm('schedule:o1');
    await settle();
    const rows = store['schedules'] as Schedule[];
    expect(rows.find((r) => r.id === 'o1')?.enabled).toBe(false);
    expect(created.find((c) => c.name === 'schedule:o1')).toBeUndefined(); // no re-arm
  });

  it('interval/daily: chrome repeats natively — no re-arm write', async () => {
    const { created } = stubChromeRW([sched('i1', true)]);
    await handleScheduleAlarm('schedule:i1');
    await settle();
    expect(created.find((c) => c.name === 'schedule:i1')).toBeUndefined();
  });
});
