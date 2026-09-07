/**
 * Standing / scheduled tasks (roadmap H3) — run a prompt on a cadence, headless
 * in the service worker, recorded as a session. The prompt is either written
 * inline or resolved from a saved workflow (a reusable prompt recipe — the shortcut
 * store); either way the run is a full agent session (`driveApiSession`), so it
 * can call any tool/adapter, reason, and summarize. (The old deterministic
 * workflow-pipeline target was removed 2026-07-09 when workflows became prompts.)
 *
 * Stored in `chrome.storage.local` (config-like, small). The `chrome.alarms`
 * themselves persist across SW restarts (browser-managed), so the SW just
 * re-registers the onAlarm listener on wake; the store is the source of truth for
 * what each alarm should do. Pure helpers (cadenceLabel / alarmInfo) are unit-
 * tested; the storage CRUD is best-effort (no-ops without chrome, like other stores).
 */

export type Cadence =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; hour: number; minute: number }
  /** Certain days of the week (0=Sun … 6=Sat, non-empty). Fires as one-shot alarms
   * re-armed on each fire (multi-day weeks aren't a fixed period). */
  | { kind: 'weekly'; days: number[]; hour: number; minute: number }
  /** Day N of the month (1–31; clamped to the month's length, so 31 ≈ end of month).
   * One-shot + re-arm — month lengths vary. */
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  /** Run once at a given date-time; fired → the schedule auto-disables. */
  | { kind: 'once'; at: number };

export interface Schedule {
  id: string;
  label: string;
  /** Optional free-text remark, shown under the row. */
  note?: string;
  /** What to run — EITHER a saved workflow (a reusable prompt recipe, i.e. a
   * shortcut): its current text is resolved at run time, so editing the workflow
   * updates every schedule that points at it. */
  shortcutId?: string;
  shortcutLabel?: string;
  /** …OR an inline prompt written straight into the schedule. Either way the run
   * is a full headless agent session (driveApiSession) — exactly as if the user
   * opened a new chat and sent that text. `shortcutId` takes precedence. */
  prompt?: string;
  cadence: Cadence;
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  /** 'running' while a run is in flight (set at start, terminal at end). */
  lastStatus?: 'ok' | 'fail' | 'running';
  /** Short outcome of the last run (rows summary, or the error). */
  lastSummary?: string;
}

/** storage.local key — exported so the panel can watch storage.onChanged for
 * live row updates (Running… → result) without polling. */
export const SCHEDULES_KEY = 'schedules';
const KEY = SCHEDULES_KEY;

export function makeScheduleId(): string {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The chrome.alarms name for a schedule (so the onAlarm handler can route it). */
export function alarmName(id: string): string {
  return `schedule:${id}`;
}

export async function listSchedules(): Promise<Schedule[]> {
  try {
    const got = await chrome.storage.local.get(KEY);
    const list = got[KEY];
    return Array.isArray(list) ? (list as Schedule[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Schedule[]): Promise<Schedule[]> {
  try {
    await chrome.storage.local.set({ [KEY]: list });
  } catch {
    /* ignore */
  }
  return list;
}

/** Upsert by id (newest-created first kept in insertion order). */
export async function saveSchedule(s: Schedule): Promise<Schedule[]> {
  const list = await listSchedules();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = s;
  else list.unshift(s);
  return writeAll(list);
}

export async function getSchedule(id: string): Promise<Schedule | undefined> {
  return (await listSchedules()).find((s) => s.id === id);
}

export async function deleteSchedule(id: string): Promise<Schedule[]> {
  const list = (await listSchedules()).filter((s) => s.id !== id);
  return writeAll(list);
}

// ── schedule-run notices ────────────────────────────────────────────────────
// One entry per finished scheduled run the user hasn't acknowledged yet. The
// runner appends; the SidePanel shows them as a top banner on open (and live
// via storage.onChanged) — clicking one opens the run's session AND removes
// the entry, so it never shows again. Capped small; storage.local like the
// schedules themselves.

export interface ScheduleNotice {
  /** The session recording this run (click → open it). */
  sessionId: string;
  scheduleId: string;
  label: string;
  ok: boolean;
  ts: number;
}

export const SCHEDULE_NOTICES_KEY = 'schedule_notices';
const MAX_NOTICES = 20;

export async function listScheduleNotices(): Promise<ScheduleNotice[]> {
  try {
    const got = await chrome.storage.local.get(SCHEDULE_NOTICES_KEY);
    const list = got[SCHEDULE_NOTICES_KEY];
    return Array.isArray(list) ? (list as ScheduleNotice[]) : [];
  } catch {
    return [];
  }
}

export async function addScheduleNotice(n: ScheduleNotice): Promise<void> {
  try {
    const list = [n, ...(await listScheduleNotices())].slice(0, MAX_NOTICES);
    await chrome.storage.local.set({ [SCHEDULE_NOTICES_KEY]: list });
  } catch {
    /* ignore */
  }
}

export async function removeScheduleNotice(sessionId: string): Promise<void> {
  try {
    const list = (await listScheduleNotices()).filter((n) => n.sessionId !== sessionId);
    await chrome.storage.local.set({ [SCHEDULE_NOTICES_KEY]: list });
  } catch {
    /* ignore */
  }
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function cadenceLabel(c: Cadence): string {
  switch (c.kind) {
    case 'daily':
      return `Daily ${pad(c.hour)}:${pad(c.minute)}`;
    case 'weekly': {
      const days = [...c.days].sort((a, b) => a - b).map((d) => WEEKDAY[d] ?? '?');
      return `Weekly ${days.join('/')} ${pad(c.hour)}:${pad(c.minute)}`;
    }
    case 'monthly':
      return `Monthly day ${c.day} ${pad(c.hour)}:${pad(c.minute)}`;
    case 'once': {
      const d = new Date(c.at);
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(
        d.getMinutes(),
      )} once`;
    }
    default: {
      const m = c.minutes;
      if (m % 1440 === 0) return `Every ${m / 1440} day(s)`;
      if (m % 60 === 0) return `Every ${m / 60} hour(s)`;
      return `Every ${m} minute(s)`;
    }
  }
}

/** Next local HH:MM strictly after `now`. */
export function nextDaily(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 86_400_000; // already passed today → tomorrow
  return t;
}

/** Next occurrence of HH:MM on one of `days` (0=Sun…6=Sat), strictly after
 * `now`. Empty/invalid `days` falls back to daily semantics. */
export function nextWeekly(days: number[], hour: number, minute: number, now: number): number {
  const valid = new Set(days.filter((d) => d >= 0 && d <= 6));
  if (valid.size === 0) return nextDaily(hour, minute, now);
  for (let add = 0; add < 8; add++) {
    const d = new Date(now + add * 86_400_000);
    d.setHours(hour, minute, 0, 0);
    if (valid.has(d.getDay()) && d.getTime() > now) return d.getTime();
  }
  return nextDaily(hour, minute, now); // unreachable
}

/** Next occurrence of `day`-of-month at HH:MM strictly after `now`. `day` is
 * clamped to each month's length (31 ≈ end of month, Feb → 28/29). */
export function nextMonthly(day: number, hour: number, minute: number, now: number): number {
  const base = new Date(now);
  for (let add = 0; add < 25; add++) {
    const y = base.getFullYear();
    const mo = base.getMonth() + add;
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    const d = new Date(y, mo, Math.min(Math.max(1, day), daysInMonth), hour, minute, 0, 0);
    if (d.getTime() > now) return d.getTime();
  }
  return nextDaily(hour, minute, now); // unreachable
}

/** Parse a loosely-typed cadence object (straight off the `create_schedule`
 * tool args) into a validated {@link Cadence}, or return an `error` string for
 * the model to correct. Every kind's required fields are checked; `minute`
 * defaults to 0. `once.at` accepts an epoch-ms number, a numeric string, or an
 * ISO datetime string (parsed in local time by `new Date`). Pure + unit-tested;
 * the intercept handler in api-engine calls it. */
export function parseCadence(raw: unknown, now: number): { cadence: Cadence } | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
      return Math.round(Number(v));
    return undefined;
  };
  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
  switch (o.kind) {
    case 'interval': {
      const minutes = int(o.minutes);
      if (minutes == null || minutes < 1)
        return { error: 'interval needs minutes (integer, ≥1)' };
      return { cadence: { kind: 'interval', minutes } };
    }
    case 'daily': {
      const hour = int(o.hour);
      if (hour == null || hour < 0 || hour > 23) return { error: 'daily needs hour (0–23)' };
      return { cadence: { kind: 'daily', hour, minute: clamp(int(o.minute) ?? 0, 0, 59) } };
    }
    case 'weekly': {
      const hour = int(o.hour);
      if (hour == null || hour < 0 || hour > 23) return { error: 'weekly needs hour (0–23)' };
      const days = Array.isArray(o.days)
        ? [
            ...new Set(o.days.map(int).filter((d): d is number => d != null && d >= 0 && d <= 6)),
          ].sort((a, b) => a - b)
        : [];
      if (!days.length) return { error: 'weekly needs days (0=Sun…6=Sat, non-empty)' };
      return { cadence: { kind: 'weekly', days, hour, minute: clamp(int(o.minute) ?? 0, 0, 59) } };
    }
    case 'monthly': {
      const hour = int(o.hour);
      if (hour == null || hour < 0 || hour > 23) return { error: 'monthly needs hour (0–23)' };
      const day = int(o.day);
      if (day == null || day < 1 || day > 31) return { error: 'monthly needs day (1–31)' };
      return { cadence: { kind: 'monthly', day, hour, minute: clamp(int(o.minute) ?? 0, 0, 59) } };
    }
    case 'once': {
      const at = parseOnceAt(o.at);
      if (at == null)
        return {
          error: 'once needs at (a future time: ISO string like 2026-07-10T09:00, or epoch ms)',
        };
      if (at <= now) return { error: 'once\'s time must be in the future' };
      return { cadence: { kind: 'once', at } };
    }
    default:
      return {
        error: `Unknown cadence.kind "${String(o.kind)}"; expected interval/daily/weekly/monthly/once`,
      };
  }
}

/** Coerce `once.at` (epoch-ms number, numeric string, or ISO datetime) to an
 * epoch-ms timestamp, or undefined if unparseable. */
function parseOnceAt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return Number(s); // epoch ms passed as a string
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** chrome.alarms.create options for a cadence. interval/daily are chrome-native
 * repeats (periodInMinutes); weekly/monthly/once are ONE-SHOT (`when` only) —
 * re-armed on fire by handleScheduleAlarm, recreated on boot when missing.
 * Their `when` is an absolute wall clock, so boot re-creation never drifts
 * (the §10.28 constraint only bites relative-period alarms). */
export function alarmInfo(c: Cadence, now: number): { when: number; periodInMinutes?: number } {
  switch (c.kind) {
    case 'daily':
      return { when: nextDaily(c.hour, c.minute, now), periodInMinutes: 1440 };
    case 'weekly':
      return { when: nextWeekly(c.days, c.hour, c.minute, now) };
    case 'monthly':
      return { when: nextMonthly(c.day, c.hour, c.minute, now) };
    case 'once':
      return { when: c.at };
    default: {
      const minutes = Math.max(1, Math.round(c.minutes));
      return { when: now + minutes * 60_000, periodInMinutes: minutes };
    }
  }
}
