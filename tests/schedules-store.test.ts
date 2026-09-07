/**
 * schedules-store — pure cadence helpers (H3-P1). CRUD is chrome.storage-backed
 * and no-ops in node, so we test cadenceLabel / next* / alarmInfo.
 */
import { describe, it, expect } from 'vitest';
import {
  cadenceLabel,
  nextDaily,
  nextWeekly,
  nextMonthly,
  alarmInfo,
  parseCadence,
  type Cadence,
} from '../src/schedules/store';

describe('cadenceLabel', () => {
  it('formats daily + interval cadences', () => {
    expect(cadenceLabel({ kind: 'daily', hour: 8, minute: 5 })).toBe('Daily 08:05');
    expect(cadenceLabel({ kind: 'interval', minutes: 30 })).toBe('Every 30 minute(s)');
    expect(cadenceLabel({ kind: 'interval', minutes: 120 })).toBe('Every 2 hour(s)');
    expect(cadenceLabel({ kind: 'interval', minutes: 2880 })).toBe('Every 2 day(s)');
  });
  it('formats weekly / monthly / once cadences', () => {
    expect(cadenceLabel({ kind: 'weekly', days: [5, 1], hour: 9, minute: 0 })).toBe(
      'Weekly Mon/Fri 09:00',
    );
    expect(cadenceLabel({ kind: 'monthly', day: 15, hour: 18, minute: 30 })).toBe(
      'Monthly day 15 18:30',
    );
    const at = new Date(2026, 6, 8, 9, 5, 0).getTime();
    expect(cadenceLabel({ kind: 'once', at })).toBe('2026/7/8 09:05 once');
  });
});

describe('nextWeekly', () => {
  // 2026-06-12 is a Friday (day 5), local 10:00.
  const now = new Date(2026, 5, 12, 10, 0, 0).getTime();
  it('same day when the time is still ahead', () => {
    const t = nextWeekly([5], 18, 0, now);
    expect(t - now).toBe(8 * 3600_000);
  });
  it('skips to the next listed weekday when today has passed', () => {
    const t = nextWeekly([5], 8, 0, now); // Friday 08:00 already passed → next Friday
    expect(t - now).toBe(7 * 86_400_000 - 2 * 3600_000);
  });
  it('picks the EARLIEST of several days', () => {
    const t = nextWeekly([1, 6], 8, 0, now); // Sat(6) tomorrow beats Mon(1)
    expect(new Date(t).getDay()).toBe(6);
    expect(t).toBeGreaterThan(now);
  });
  it('falls back to daily semantics on an empty day set', () => {
    expect(nextWeekly([], 18, 0, now)).toBe(nextDaily(18, 0, now));
  });
});

describe('nextMonthly', () => {
  const now = new Date(2026, 5, 12, 10, 0, 0).getTime(); // 2026-06-12
  it('this month when the day is still ahead', () => {
    const t = nextMonthly(15, 8, 0, now);
    const d = new Date(t);
    expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([5, 15, 8]);
  });
  it('next month when the day has passed', () => {
    const t = nextMonthly(1, 8, 0, now);
    const d = new Date(t);
    expect([d.getMonth(), d.getDate()]).toEqual([6, 1]);
  });
  it('clamps day 31 to the month length (月末)', () => {
    const t = nextMonthly(31, 8, 0, now);
    const d = new Date(t);
    expect([d.getMonth(), d.getDate()]).toEqual([5, 30]); // June has 30 days
  });
});

describe('nextDaily', () => {
  it('returns a strictly-future timestamp at the right local HH:MM', () => {
    const now = new Date(2026, 5, 12, 10, 0, 0).getTime(); // local 10:00
    // 08:00 already passed today → tomorrow 08:00
    const morning = nextDaily(8, 0, now);
    expect(morning).toBeGreaterThan(now);
    const dm = new Date(morning);
    expect(dm.getHours()).toBe(8);
    expect(dm.getMinutes()).toBe(0);
    expect(morning - now).toBeGreaterThan(20 * 3600_000); // ~22h away
    // 18:00 still ahead today → today 18:00
    const evening = nextDaily(18, 0, now);
    expect(evening - now).toBe(8 * 3600_000);
  });
});

describe('parseCadence', () => {
  const now = new Date(2026, 5, 12, 10, 0, 0).getTime(); // 2026-06-12 10:00
  const ok = (r: ReturnType<typeof parseCadence>): Cadence => {
    if ('error' in r) throw new Error(`expected cadence, got error: ${r.error}`);
    return r.cadence;
  };

  it('parses each kind with defaults + coercion', () => {
    expect(ok(parseCadence({ kind: 'interval', minutes: 30 }, now))).toEqual({
      kind: 'interval',
      minutes: 30,
    });
    // minute defaults to 0; numeric strings are coerced.
    expect(ok(parseCadence({ kind: 'daily', hour: '9' }, now))).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 0,
    });
    // weekly: dedupes + sorts days.
    expect(ok(parseCadence({ kind: 'weekly', days: [5, 1, 5], hour: 9, minute: 30 }, now))).toEqual(
      {
        kind: 'weekly',
        days: [1, 5],
        hour: 9,
        minute: 30,
      },
    );
    expect(ok(parseCadence({ kind: 'monthly', day: 15, hour: 18 }, now))).toEqual({
      kind: 'monthly',
      day: 15,
      hour: 18,
      minute: 0,
    });
  });

  it('accepts once.at as ISO string OR epoch ms, both in the future', () => {
    const iso = ok(parseCadence({ kind: 'once', at: '2026-07-10T09:00' }, now));
    expect(iso.kind).toBe('once');
    expect(new Date((iso as { at: number }).at).getHours()).toBe(9);
    const ms = now + 3_600_000;
    expect(ok(parseCadence({ kind: 'once', at: ms }, now))).toEqual({ kind: 'once', at: ms });
    expect(ok(parseCadence({ kind: 'once', at: String(ms) }, now))).toEqual({
      kind: 'once',
      at: ms,
    });
  });

  it('rejects invalid / missing fields with an error string', () => {
    expect(parseCadence({ kind: 'interval', minutes: 0 }, now)).toHaveProperty('error');
    expect(parseCadence({ kind: 'daily', hour: 24 }, now)).toHaveProperty('error');
    expect(parseCadence({ kind: 'weekly', hour: 9, days: [] }, now)).toHaveProperty('error');
    expect(parseCadence({ kind: 'monthly', hour: 9 }, now)).toHaveProperty('error'); // no day
    expect(parseCadence({ kind: 'once', at: now - 1000 }, now)).toHaveProperty('error'); // past
    expect(parseCadence({ kind: 'once', at: 'not-a-date' }, now)).toHaveProperty('error');
    expect(parseCadence({ kind: 'nope' }, now)).toHaveProperty('error');
    expect(parseCadence(null, now)).toHaveProperty('error');
  });
});

describe('alarmInfo', () => {
  it('interval → first fire now+period, period = minutes', () => {
    const now = 1_000_000;
    const c: Cadence = { kind: 'interval', minutes: 15 };
    expect(alarmInfo(c, now)).toEqual({ when: now + 15 * 60_000, periodInMinutes: 15 });
  });
  it('daily → first fire next HH:MM, period = 1440', () => {
    const now = new Date(2026, 5, 12, 10, 0, 0).getTime();
    const info = alarmInfo({ kind: 'daily', hour: 9, minute: 30 }, now);
    expect(info.periodInMinutes).toBe(1440);
    expect(info.when).toBeGreaterThan(now);
    expect(new Date(info.when).getHours()).toBe(9);
  });
  it('clamps a sub-minute interval to 1 minute', () => {
    expect(alarmInfo({ kind: 'interval', minutes: 0 }, 0).periodInMinutes).toBe(1);
  });
  it('weekly / monthly / once are ONE-SHOT (no periodInMinutes — re-armed on fire)', () => {
    const now = new Date(2026, 5, 12, 10, 0, 0).getTime();
    const weekly = alarmInfo({ kind: 'weekly', days: [1], hour: 8, minute: 0 }, now);
    expect(weekly.periodInMinutes).toBeUndefined();
    expect(weekly.when).toBeGreaterThan(now);
    const monthly = alarmInfo({ kind: 'monthly', day: 1, hour: 8, minute: 0 }, now);
    expect(monthly.periodInMinutes).toBeUndefined();
    const once = alarmInfo({ kind: 'once', at: now + 60_000 }, now);
    expect(once).toEqual({ when: now + 60_000 });
  });
});
