/**
 * Scheduled-task runner (H3) — fired by `chrome.alarms`. Every task is a PROMPT:
 * either written inline (`sch.prompt`) or resolved from a saved workflow (a reusable
 * prompt recipe in the shortcut store, `sch.shortcutId`). It drives a FULL agent
 * session (`driveApiSession`) — identical to the user opening a new chat and
 * sending that text — so the agent can call any tool/adapter, reason, and write
 * its own final summary. (The old deterministic workflow-pipeline target + its
 * LLM digest were removed 2026-07-09 when workflows became prompts.)
 *
 * runScheduleNow returns AS SOON AS the run session exists (status 'running',
 * already visible in the session history) — completion continues async and lands a
 * ScheduleNotice (panel top banner) + desktop notification (panel closed).
 */
import {
  getSchedule,
  saveSchedule,
  listSchedules,
  deleteSchedule,
  alarmName,
  alarmInfo,
  addScheduleNotice,
  type Schedule,
} from '../schedules/store';
import { getShortcut } from '../shortcuts/store';
import {
  makeSession,
  makeSessionId,
  appendTurn,
  saveSession,
  type SessionState,
} from '../agent/session';
import { notifyScheduleDone } from './notifications';
import { driveApiSession } from './engine-driver';
import { log, warn } from '@base/runtime/log';

const SCOPE = 'schedule';

/** A run older than this with lastStatus 'running' is considered dead (SW was
 * killed mid-run) — allow a new run instead of blocking forever. */
const RUNNING_STALE_MS = 10 * 60_000;

/** Resolve a schedule to the prompt text it should run: a saved workflow's current
 * text (by shortcutId — so editing the workflow updates the task), else the inline
 * prompt. Empty string when the referenced workflow was deleted / nothing set. */
async function resolvePrompt(sch: Schedule): Promise<string> {
  if (sch.shortcutId) {
    const sc = await getShortcut(sch.shortcutId);
    return (sc?.text ?? '').trim();
  }
  return (sch.prompt ?? '').trim();
}

/** Start a schedule run NOW. Resolves as soon as the run's session exists —
 * the panel gets instant feedback and the session history shows the session as
 * in-progress; execution continues asynchronously (finishScheduleRun). */
export async function runScheduleNow(
  id: string,
): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const sch = await getSchedule(id);
  if (!sch) return { ok: false, error: 'schedule not found' };
  if (
    sch.lastStatus === 'running' &&
    sch.lastRun != null &&
    Date.now() - sch.lastRun < RUNNING_STALE_MS
  ) {
    return { ok: false, error: 'This task is already running, please wait for it to finish' };
  }

  const session = makeSession(makeSessionId());
  session.schedule = { id: sch.id, label: sch.label };
  session.status = 'running';
  await saveSession(session); // visible in the session history as in-progress right away
  await saveSchedule({
    ...sch,
    lastRun: Date.now(),
    lastStatus: 'running',
    lastSummary: 'Running…',
  });
  void finishScheduleRun(sch, session);
  return { ok: true, sessionId: session.id };
}

/** The async tail of a run: execute the prompt as a full agent session, record
 * terminal status, update the schedule row, drop the panel notice, ping the
 * desktop. Never throws. */
async function finishScheduleRun(sch: Schedule, session: SessionState): Promise<void> {
  let allOk: boolean;
  let outcome: string;
  try {
    const promptText = await resolvePrompt(sch);
    if (!promptText) {
      throw new Error(
        sch.shortcutId
          ? 'The referenced workflow was deleted or is empty'
          : 'The scheduled task has no content to run',
      );
    }
    // Full agent session — the engine appends its own user turn, maintains
    // status (running → idle/error) and persists as it goes. No auto-approve:
    // with the panel open the write-confirm card appears (background session
    // awaiting input); closed, writes time out declined — scheduled tasks should be
    // read/report tasks.
    await driveApiSession(session, promptText, 'chat', undefined, false, {
      displayText: `⏰ Scheduled task: ${sch.label}`,
    });
    allOk = session.status !== 'error';
    outcome = allOk ? 'Done' : 'Error (see session)';
  } catch (e) {
    allOk = false;
    outcome = (e instanceof Error ? e.message : String(e)).slice(0, 120);
    session.status = 'error';
    // Record the failure as an assistant turn so the opened session isn't blank.
    appendTurn(session, {
      role: 'assistant',
      cleanedText: `Scheduled task "${sch.label}" failed to run: ${outcome}`,
      commands: [],
      iteration: 0,
      ts: Date.now(),
    });
    await saveSession(session).catch(() => {});
    warn(SCOPE, 'schedule run failed', e);
  }
  // Re-read the schedule for the final write — a 'once' cadence may have been
  // auto-disabled (handleScheduleAlarm) while we ran; don't resurrect it.
  const cur = await getSchedule(sch.id);
  if (cur) {
    await saveSchedule({
      ...cur,
      lastRun: Date.now(),
      lastStatus: allOk ? 'ok' : 'fail',
      lastSummary: `${outcome} → session history`,
    });
  }
  await addScheduleNotice({
    sessionId: session.id,
    scheduleId: sch.id,
    label: sch.label,
    ok: allOk,
    ts: Date.now(),
  });
  void notifyScheduleDone(sch.label, allOk, session.id);
  log(SCOPE, `schedule ${sch.id} finished ok=${allOk}`);
}

/** Create or clear the chrome.alarm for a schedule (enabled + cadence). */
export async function syncAlarm(sch: Schedule): Promise<void> {
  try {
    await chrome.alarms.clear(alarmName(sch.id));
    if (sch.enabled)
      await chrome.alarms.create(alarmName(sch.id), alarmInfo(sch.cadence, Date.now()));
  } catch (e) {
    warn('schedule', 'syncAlarm failed', e);
  }
}

/** Re-sync every schedule's alarm on SW startup. Alarms PERSIST across SW
 * restarts, and MV3 recycles the SW on nearly every event — so this must NOT
 * clear+recreate an existing interval alarm: that pushes its next fire to
 * `now+period` on every boot, so any schedule longer than the inter-boot gap
 * would (nearly) never fire (daily is safe — its `when` is an absolute wall
 * clock). Create only the MISSING alarms; clear disabled ones. Cadence edits are
 * handled by the explicit syncAlarm() at edit time, not here. See §10.28. */
export async function syncAllAlarms(): Promise<void> {
  await cleanupLegacyWorkflows();
  for (const sch of await listSchedules()) {
    const name = alarmName(sch.id);
    if (!sch.enabled) {
      await chrome.alarms.clear(name);
      continue;
    }
    const existing = await chrome.alarms.get(name);
    if (!existing) await chrome.alarms.create(name, alarmInfo(sch.cadence, Date.now()));
  }
}

/** One-time-ish boot cleanup after workflows became prompts (2026-07-09, no
 * migration): drop the orphaned `workflows` storage key and prune legacy
 * schedules that still target a deleted workflow (`workflowId`, no prompt /
 * shortcut) — clearing their alarms. Idempotent; cheap enough to run each boot. */
async function cleanupLegacyWorkflows(): Promise<void> {
  try {
    await chrome.storage?.local?.remove?.('workflows');
  } catch {
    /* ignore */
  }
  try {
    const list = await listSchedules();
    const stale = list.filter(
      (s) =>
        !s.prompt?.trim() &&
        !s.shortcutId &&
        (s as { workflowId?: string }).workflowId !== undefined,
    );
    for (const s of stale) {
      try {
        await chrome.alarms.clear(alarmName(s.id));
      } catch {
        /* ignore */
      }
      await deleteSchedule(s.id);
    }
  } catch (e) {
    warn(SCOPE, 'legacy workflow cleanup failed', e);
  }
}

/** chrome.alarms.onAlarm router — runs a schedule when its alarm fires.
 * weekly/monthly cadences fire as ONE-SHOT alarms (no fixed period): re-arm the
 * next occurrence BEFORE running so a crash mid-run can't kill the series.
 * 'once' retires itself (enabled=false) after its single fire. Returns the
 * promise for tests; production callers void it. */
export function handleScheduleAlarm(name: string): Promise<void> | void {
  if (!name.startsWith('schedule:')) return;
  const id = name.slice('schedule:'.length);
  return (async () => {
    const sch = await getSchedule(id);
    if (!sch || !sch.enabled) return;
    if (sch.cadence.kind === 'weekly' || sch.cadence.kind === 'monthly') {
      try {
        await chrome.alarms.create(alarmName(id), alarmInfo(sch.cadence, Date.now()));
      } catch (e) {
        warn(SCOPE, 're-arm failed', e);
      }
    } else if (sch.cadence.kind === 'once') {
      await saveSchedule({ ...sch, enabled: false });
    }
    await runScheduleNow(id);
  })();
}
