/**
 * Service worker — central message router + agent host.
 *
 * Responsibilities:
 *   - Open the side panel on toolbar action click.
 *   - Route SidePanel ↔ Tool dispatcher messages (USER_MESSAGE / ABORT /
 *     write-confirm / log forwarding / adapter install).
 *   - Drive an api-engine session per user message (fire-and-forget so the
 *     SidePanel's sendMessage ack returns immediately — the actual progress
 *     stream lands later via ASSISTANT_TURN / TOOL_TRACE / SESSION_DONE).
 *   - Boot-time: register runtime-installed adapters into the live registry,
 *     configure the USER_SCRIPT-world for Phase B func adapters.
 *
 * History: an earlier "connector" mode hijacked a logged-in DeepSeek tab for
 * inference. That path required tab tracking (onRemoved/onUpdated), pause/
 * resume on tab loss, INJECT_PROMPT/CHATBOT_RESPONSE plumbing, etc. — all
 * removed when the only-mode-now (api) doesn't need any chatbot tab. Tool
 * execution still uses chrome.tabs/debugger to drive arbitrary target sites
 * via the adapter dispatcher, but that's site-agnostic and lives elsewhere.
 */

import { log, warn, error as logError, ingestEntry, getLocalBuffer } from '../runtime/log';
import {
  deleteSession,
  listSessions,
  loadSession,
  makeSession,
  saveSession,
  type SessionState,
} from '../agent/session';
import { executeAdapter } from '../tools/dispatcher';
import { lookupAdapter } from '../tools/manifest';
import { apiEngine } from '../agent/api-engine';
import type { EngineContext, OrchEvent, ToolExecResult } from '../agent/engine';
import type { PlanState } from '../agent/plan';
import { listMemories, deleteMemory } from '../agent/memory-store';
import { ExploreSession } from '../explore/session';
import { getTrace } from '../explore/trace-store';
import { synthesizeAdapter } from '../explore/synthesize';
import { resolveSlots } from '../config/llm-config';
import type {
  AbortSessionReq,
  SteerMessageReq,
  AssistantTurnEvt,
  AssistantTurnPatchEvt,
  RunStatsEvt,
  DeleteSessionReq,
  GetSessionReq,
  GetSessionResp,
  IterationProgressEvt,
  ListSessionsReq,
  ListSessionsResp,
  LogEntryEvt,
  LogsResponse,
  Message,
  RequestLogsReq,
  SessionDoneEvt,
  SessionNoticeEvt,
  PlanUpdatedEvt,
  ExploreResultEvt,
  SessionSummary,
  ToolTraceEvt,
  UserMessageReq,
  WriteConfirmReq,
  WriteConfirmResp,
  PlanDecisionReq,
  PlanDecisionResp,
  PlanDecision,
  InstallAdapterReq,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  ListInstalledResp,
  InstalledAdapterSummary,
  AdaptersChangedEvt,
  DeleteMemoryReq,
  RunToolReq,
  RunToolResp,
  ExploreRepairReq,
  SetAdapterVerifyReq,
  GetTraceReq,
} from '../messages';

// Side-effect import: registers site-independent web-operation adapters
// (open_url, get_page_text, screenshot, scroll, click, type, …) which the
// agent uses to navigate / scrape arbitrary pages without a site adapter.
// Per-site adapters (xiaohongshu, twitter, …) are installed from the
// marketplace at runtime — no built-in site directories.
import '../tools/generic/_all';

// Runtime-installed adapters (hot-plug): registered from IndexedDB on boot,
// and installed/uninstalled at runtime via the message router below.
import {
  installFromCaptured,
  loadInstalledOnBoot,
  uninstall as uninstallAdapter,
  setEnabled as setAdapterEnabled,
  listInstalledAdapters,
  findStaleMarketplaceAdapters,
  markVerified,
} from '../adapters/install-manager';
import {
  configureWebchatWorld,
  handleRunnerPortConnect,
  isUserScriptsApiAvailable,
} from '../userscript/sw-runner';

const SCOPE = 'sw';

/* ───────── runtime state (lost on SW termination) ───────── */

interface ActiveSession {
  session: SessionState;
  abort: AbortController;
}

/** Sessions currently being driven by an engine. Cleared when finished /
 * aborted. The session object itself is also persisted via IDB — restart-
 * safe state lives in `SessionState`. */
const activeSessions = new Map<string, ActiveSession>();

/** SidePanel-bound write-confirm prompts. Resolves true on approval,
 * false on decline / timeout / panel close. */
const pendingConfirmations = new Map<string, { resolve: (approved: boolean) => void }>();
const WRITE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** SidePanel-bound plan-approval prompts (plan mode). Resolves with the user's
 * decision; rejects on timeout / panel close. */
const pendingPlanDecisions = new Map<string, { resolve: (d: PlanDecision) => void }>();
const PLAN_DECISION_TIMEOUT_MS = 10 * 60 * 1000;

/** Messages injected into a running session via STEER_MESSAGE, drained by the
 * engine on its next turn. Keyed by sessionId. */
const steerQueue = new Map<string, string[]>();

/** Open keep-alive ports from extension pages (SidePanel). Originally we
 * relied SOLELY on an open port to pin the SW — but an IDLE connected port
 * does NOT reliably reset Chrome's 30s idle timer (observed: "keepalive port
 * connected" logged, yet the SW still got recycled mid-`bilibili__comment`,
 * which waits on a write-confirm + userScripts RPC with no chrome.* calls of
 * its own). The reliable mechanism is the active self-ping below; the port is
 * kept as a secondary signal + so the SW dies promptly when the panel closes. */
const keepaliveConnections = new Set<chrome.runtime.Port>();

/** Active self-ping: while ANY session is being driven, fire a cheap chrome.*
 * call every 20s (< the 30s idle timeout) so the worker is never recycled
 * mid-turn. setInterval only ticks while the SW is alive, and each tick's
 * chrome.* call resets the idle timer — so an active session keeps the SW
 * alive indefinitely, and it's released the moment the last session ends.
 * This is what actually fixes the "会话因扩展后台被回收而中断了" interruptions;
 * the open port alone did not. */
let keepalivePingTimer: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_PING_MS = 20_000;
function startKeepalivePing(): void {
  if (keepalivePingTimer) return;
  keepalivePingTimer = setInterval(() => {
    // Any async extension API call counts as activity and resets the 30s
    // idle timer. getPlatformInfo is cheap and side-effect-free.
    try {
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    } catch {
      /* SW tearing down; nothing to do */
    }
  }, KEEPALIVE_PING_MS);
}
function stopKeepalivePingIfIdle(): void {
  if (keepalivePingTimer && activeSessions.size === 0) {
    clearInterval(keepalivePingTimer);
    keepalivePingTimer = null;
  }
}

/* ───────── lifecycle ───────── */

log(SCOPE, 'service worker booting');
void recoverInterruptedSessionsOnBoot();
// Restore runtime-installed adapters into the live registry. Fire-and-forget:
// boot shouldn't block on IDB, and a brand-new install has nothing to restore.
void loadInstalledOnBoot().catch((e) => warn(SCOPE, 'loadInstalledOnBoot failed', e));
// Phase B: set up the USER_SCRIPT-world we inject installed func adapters
// into. configureWorld is idempotent; we still call it eagerly so the first
// adapter invocation doesn't pay the cost (and so failures — most likely
// "Allow user scripts" disabled — surface in logs at boot, not on first call).
void configureWebchatWorld();

chrome.runtime.onInstalled.addListener(() => {
  log(SCOPE, 'onInstalled');
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => warn(SCOPE, 'setPanelBehavior failed', e));
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'webchat-keepalive') {
    keepaliveConnections.add(port);
    log(SCOPE, `keepalive port connected (total=${keepaliveConnections.size})`);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume bfcache/disconnect lastError
      keepaliveConnections.delete(port);
      log(SCOPE, `keepalive port disconnected (remaining=${keepaliveConnections.size})`);
    });
    return;
  }
  log(SCOPE, `unexpected onConnect port name=${port.name} — ignored`);
});

// USER_SCRIPT-world (Phase B runner) ports come through a SEPARATE event —
// chrome.runtime.onUserScriptConnect — NOT onConnect. The userScripts API
// deliberately isolates user-script messaging so an extension can't
// accidentally cross-talk between its content-script port set and its
// user-script port set. Symptom of getting this wrong: runner connects
// successfully (its DOM marker says status='connected'), but the SW's
// onConnect listener never fires → 60s timeout, "no active session" warn
// never appears either. Use the dedicated event.
if (chrome.runtime.onUserScriptConnect) {
  chrome.runtime.onUserScriptConnect.addListener((port) => {
    handleRunnerPortConnect(port);
  });
} else {
  warn(
    SCOPE,
    'chrome.runtime.onUserScriptConnect not available — Phase B func adapters will not receive port connections',
  );
}

/** On boot, find any persisted session whose status was 'running' at the
 * moment the prior SW instance died and mark it as 'error'. Its in-memory
 * activeSessions entry is gone with the worker, so the engine can't continue
 * from where it left off — the user has to retry the last message. We push
 * SESSION_DONE so the SidePanel clears any stale "正在生成" banner. */
async function recoverInterruptedSessionsOnBoot(): Promise<void> {
  try {
    const sessions = await listSessions({ status: 'running' });
    for (const s of sessions) {
      // If this boot was triggered by a USER_MESSAGE that's already resuming
      // the session, it's live again — don't mark it errored or pop a spurious
      // "interrupted" banner over an in-flight turn.
      if (activeSessions.has(s.id)) continue;
      log(SCOPE, `recovering interrupted session ${s.id}`);
      s.status = 'error';
      await saveSession(s);
      sendToSidepanel({
        type: 'SESSION_DONE',
        sessionId: s.id,
        reason: 'error',
        recoverable: true, // history is in IDB; keep the binding so 继续 resumes it
        error: '会话因扩展后台被回收而中断了。再发一句话可以接着聊（基于历史上下文）。',
      } satisfies SessionDoneEvt);
    }
  } catch (e) {
    warn(SCOPE, 'recoverInterruptedSessionsOnBoot failed', e);
  }
}

chrome.action.onClicked.addListener((tab) => {
  log(SCOPE, 'action clicked', { tabId: tab.id });
  if (tab.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id }).catch((e) => warn(SCOPE, 'sidePanel.open', e));
  }
});

/* ───────── message router ───────── */

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse): boolean | undefined => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Message;
  switch (m.type) {
    case 'USER_MESSAGE': {
      const r = m as UserMessageReq;
      sendResponse({ ok: true });
      void handleUserMessage(r);
      return false;
    }
    case 'ABORT_SESSION': {
      handleAbort(m as AbortSessionReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'STEER_MESSAGE': {
      handleSteer(m as SteerMessageReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'REQUEST_LOGS': {
      sendResponse(handleRequestLogs(m as RequestLogsReq));
      return false;
    }
    case 'GET_SESSION_STATE': {
      sendResponse({ activeSessionIds: [...activeSessions.keys()] });
      return false;
    }
    case 'LIST_SESSIONS': {
      void handleListSessions(m as ListSessionsReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'GET_SESSION': {
      void handleGetSession(m as GetSessionReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'DELETE_SESSION': {
      void handleDeleteSession(m as DeleteSessionReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'WRITE_CONFIRM_RESP': {
      handleWriteConfirmResp(m as WriteConfirmResp);
      return false;
    }
    case 'PLAN_DECISION_RESP': {
      handlePlanDecisionResp(m as PlanDecisionResp);
      return false;
    }
    case 'LOG_ENTRY': {
      ingestEntry((m as LogEntryEvt).entry);
      return false;
    }
    case 'INSTALL_ADAPTER': {
      void handleInstallAdapter(m as InstallAdapterReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ type: 'INSTALL_ADAPTER_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'UNINSTALL_ADAPTER': {
      void handleUninstallAdapter(m as UninstallAdapterReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'SET_ADAPTER_ENABLED': {
      void handleSetAdapterEnabled(m as SetAdapterEnabledReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'LIST_INSTALLED': {
      void handleListInstalled().then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'LIST_STALE_ADAPTERS': {
      void findStaleMarketplaceAdapters().then(
        (stale) => sendResponse({ type: 'LIST_STALE_ADAPTERS_RESP', stale }),
        () => sendResponse({ type: 'LIST_STALE_ADAPTERS_RESP', stale: [] }),
      );
      return true;
    }
    case 'LIST_MEMORIES': {
      void listMemories().then(
        (memories) => sendResponse({ type: 'LIST_MEMORIES_RESP', memories }),
        () => sendResponse({ type: 'LIST_MEMORIES_RESP', memories: [] }),
      );
      return true;
    }
    case 'RUN_TOOL': {
      void handleRunTool(m as RunToolReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ type: 'RUN_TOOL_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'EXPLORE_REPAIR': {
      sendResponse({ ok: true });
      void handleExploreRepair(m as ExploreRepairReq);
      return false;
    }
    case 'GET_TRACE': {
      void getTrace((m as GetTraceReq).traceId).then(
        (trace) => sendResponse({ type: 'GET_TRACE_RESP', trace }),
        () => sendResponse({ type: 'GET_TRACE_RESP', trace: null }),
      );
      return true;
    }
    case 'SET_ADAPTER_VERIFY': {
      const r = m as SetAdapterVerifyReq;
      void markVerified(r.id, r.status, r.note).then(
        () => {
          broadcastAdaptersChanged();
          sendResponse({ ok: true });
        },
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    case 'DELETE_MEMORY': {
      void deleteMemory((m as DeleteMemoryReq).id).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    default:
      return;
  }
});

/* ───────── handlers ───────── */

/** Wait (briefly) for a session to leave activeSessions after we aborted it, so
 * a takeover doesn't run two drivers for the same id. Resolves true once idle,
 * false on timeout. §10.20 */
function waitForSessionIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
  if (!activeSessions.has(sessionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const iv = setInterval(() => {
      if (!activeSessions.has(sessionId)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 50);
  });
}

async function handleUserMessage(m: UserMessageReq): Promise<void> {
  log(SCOPE, `USER_MESSAGE sessionId=${m.sessionId}`, { text: m.text.slice(0, 80) });
  // The panel only sends USER_MESSAGE when it believes the session is idle (a
  // running session gets a STEER instead), so an active session here is a desync
  // — usually a run stuck awaiting a plan decision (the dropped-card hang). Don't
  // hard-error "already running"; abort the stale run and take over, so a
  // reopened/errored session can always be continued. §10.20
  if (activeSessions.has(m.sessionId)) {
    log(SCOPE, `USER_MESSAGE for active ${m.sessionId} → abort stale run + take over`);
    activeSessions.get(m.sessionId)?.abort.abort();
    if (!(await waitForSessionIdle(m.sessionId, 2000))) {
      warn(SCOPE, `stale run ${m.sessionId} didn't free in time; forcing takeover`);
      activeSessions.delete(m.sessionId);
    }
  }
  const session = (await loadSession(m.sessionId)) ?? makeSession(m.sessionId);
  await driveApiSession(session, m.text, m.mode);
}

function handleAbort(m: AbortSessionReq): void {
  const entry = activeSessions.get(m.sessionId);
  if (!entry) return;
  log(SCOPE, `aborting session ${m.sessionId}`);
  entry.abort.abort();
}

/** Queue a steering message for a running session — the engine drains it at the
 * top of its loop AND right before it finishes (api-engine `drainSteers`), so a
 * steer landing on the final turn still gets folded in. If the session already
 * went idle (the steer lost the race against completion), don't drop the user's
 * typed text: re-route it as a normal follow-up turn. See docs/agent-harness.md §10.14. */
function handleSteer(m: SteerMessageReq): void {
  if (activeSessions.has(m.sessionId)) {
    enqueueSteer(m.sessionId, m.text);
    return;
  }
  void rerouteSteerAsFollowUp(m);
}

function enqueueSteer(sessionId: string, text: string): void {
  const q = steerQueue.get(sessionId) ?? [];
  q.push(text);
  steerQueue.set(sessionId, q);
  log(SCOPE, `steer queued for ${sessionId}`, { pending: q.length });
}

/** A steer that arrived after its session went idle (race against the final
 * turn finishing). Continue the saved session with the steer as a fresh user
 * turn so it's persisted + answered instead of silently lost. */
async function rerouteSteerAsFollowUp(m: SteerMessageReq): Promise<void> {
  const session = await loadSession(m.sessionId);
  if (!session) {
    log(SCOPE, `steer dropped: unknown session ${m.sessionId}`);
    return;
  }
  if (activeSessions.has(m.sessionId)) {
    // A new turn started while we were loading — queue for that run instead.
    enqueueSteer(m.sessionId, m.text);
    return;
  }
  log(SCOPE, `steer for idle ${m.sessionId} → follow-up turn`);
  await driveApiSession(session, m.text);
}

function handleRequestLogs(_m: RequestLogsReq): LogsResponse {
  return { type: 'LOGS_RESPONSE', entries: getLocalBuffer() };
}

/* ───────── runtime adapter install / marketplace ───────── */

/** Persist + register an adapter the SidePanel's sandbox already eval'd into
 * captured defs. The SW never evals — it only consumes serializable data. */
async function handleInstallAdapter(m: InstallAdapterReq) {
  const r = await installFromCaptured(
    { source: m.source, defs: m.defs, origin: m.origin },
    Date.now(),
  );
  if (r.ok) broadcastAdaptersChanged();
  return {
    type: 'INSTALL_ADAPTER_RESP' as const,
    ok: r.ok,
    id: r.id,
    title: r.title,
    registered: r.registered,
    deferredFunc: r.deferredFunc,
    deferredUnsupported: r.deferredUnsupported,
    error: r.error,
  };
}

async function handleUninstallAdapter(m: UninstallAdapterReq): Promise<void> {
  await uninstallAdapter(m.id);
  broadcastAdaptersChanged();
}

async function handleSetAdapterEnabled(m: SetAdapterEnabledReq): Promise<void> {
  await setAdapterEnabled(m.id, m.enabled);
  broadcastAdaptersChanged();
}

async function handleListInstalled(): Promise<ListInstalledResp> {
  const rows = await listInstalledAdapters();
  const adapters: InstalledAdapterSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    enabled: r.enabled,
    commandCount: r.defs.length,
    installedAt: r.installedAt,
    origin: r.origin,
    verifyStatus: r.verifyStatus,
    verifyNote: r.verifyNote,
  }));
  return { type: 'LIST_INSTALLED_RESP', adapters };
}

/** Tell the SidePanel the installed set changed so it refreshes its lists.
 * (The agent's tool whitelist is read live from the registry, so no extra
 * push is needed there.) */
function broadcastAdaptersChanged(): void {
  sendToSidepanel({ type: 'ADAPTERS_CHANGED' } satisfies AdaptersChangedEvt);
}

async function handleListSessions(m: ListSessionsReq): Promise<ListSessionsResp> {
  const sessions = await listSessions({ limit: m.limit ?? 100 });
  return {
    type: 'LIST_SESSIONS_RESP',
    sessions: sessions.map(summarise),
  };
}

function summarise(s: SessionState): SessionSummary {
  let preview = '';
  let toolCallCount = 0;
  for (const t of s.history) {
    if (!preview && t.role === 'user') preview = t.text;
    if (t.role === 'tool_trace') toolCallCount += 1;
  }
  return {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: s.status,
    iterations: s.iterations,
    preview: preview.slice(0, 200),
    turnCount: s.history.filter((t) => t.role === 'user' || t.role === 'assistant').length,
    toolCallCount,
  };
}

async function handleGetSession(m: GetSessionReq): Promise<GetSessionResp> {
  const s = await loadSession(m.sessionId);
  return { type: 'GET_SESSION_RESP', session: s };
}

async function handleDeleteSession(m: DeleteSessionReq): Promise<void> {
  log(SCOPE, `DELETE_SESSION ${m.sessionId}`);
  const entry = activeSessions.get(m.sessionId);
  if (entry) {
    // Stop any in-flight work before we delete the persisted row.
    entry.abort.abort();
    activeSessions.delete(m.sessionId);
  }
  await deleteSession(m.sessionId);
}

function handleWriteConfirmResp(m: WriteConfirmResp): void {
  const pending = pendingConfirmations.get(m.confirmId);
  if (!pending) {
    warn(SCOPE, `unmatched WRITE_CONFIRM_RESP confirmId=${m.confirmId}`);
    return;
  }
  pendingConfirmations.delete(m.confirmId);
  log(SCOPE, `write confirm resolved confirmId=${m.confirmId}`, { approved: m.approved });
  pending.resolve(m.approved);
}

/** Ask the SidePanel for explicit user approval before running a write
 * adapter. Returns true on approve, false on decline / timeout. */
function requestWriteConfirmation(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  description?: string,
): Promise<boolean> {
  const confirmId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  log(SCOPE, `requesting write-confirm for ${tool}`, { confirmId, args });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirmations.has(confirmId)) return;
      pendingConfirmations.delete(confirmId);
      warn(SCOPE, `write-confirm timeout confirmId=${confirmId}`);
      resolve(false);
    }, WRITE_CONFIRM_TIMEOUT_MS);
    pendingConfirmations.set(confirmId, {
      resolve: (approved: boolean) => {
        clearTimeout(timer);
        resolve(approved);
      },
    });
    const req: WriteConfirmReq = {
      type: 'WRITE_CONFIRM_REQ',
      sessionId,
      confirmId,
      tool,
      args,
      description,
    };
    sendToSidepanel(req);
  });
}

/** Ask the SidePanel to approve a proposed plan before the agent leaves the
 * read-only planning phase (plan mode). Resolves with the decision; rejects on
 * timeout / panel close. Mirrors requestWriteConfirmation. */
function requestPlanDecision(sessionId: string, plan: PlanState): Promise<PlanDecision> {
  const decisionId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  log(SCOPE, `requesting plan decision`, { decisionId, steps: plan.steps.length });
  const req: PlanDecisionReq = { type: 'PLAN_DECISION_REQ', sessionId, decisionId, plan };
  return new Promise<PlanDecision>((resolve) => {
    // Re-send the card request periodically. A single SW→panel message can be
    // dropped/raced under MV3 (or miss a panel that reloaded mid-run), which
    // would hang the whole run awaiting a decision the user was never shown.
    // The panel dedups by decisionId and ignores re-sends for a decided one. §10.19
    const resend = setInterval(() => sendToSidepanel(req), 3000);
    const timer = setTimeout(() => {
      if (!pendingPlanDecisions.has(decisionId)) return;
      pendingPlanDecisions.delete(decisionId);
      clearInterval(resend);
      warn(SCOPE, `plan-decision timeout ${decisionId}`);
      resolve({ decision: 'reject' });
    }, PLAN_DECISION_TIMEOUT_MS);
    const resolver = (d: PlanDecision): void => {
      clearTimeout(timer);
      clearInterval(resend);
      resolve(d);
    };
    pendingPlanDecisions.set(decisionId, { resolve: resolver });
    // The user Stopping (or a takeover) must unblock this await — otherwise the
    // run stays stuck in activeSessions and "继续" hits "already running". §10.20
    const signal = activeSessions.get(sessionId)?.abort.signal;
    const onAbort = (): void => {
      if (!pendingPlanDecisions.has(decisionId)) return;
      pendingPlanDecisions.delete(decisionId);
      log(SCOPE, `plan-decision aborted ${decisionId}`);
      resolver({ decision: 'reject' });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    sendToSidepanel(req);
  });
}

function handlePlanDecisionResp(m: PlanDecisionResp): void {
  const pending = pendingPlanDecisions.get(m.decisionId);
  if (!pending) {
    warn(SCOPE, `unmatched PLAN_DECISION_RESP decisionId=${m.decisionId}`);
    return;
  }
  pendingPlanDecisions.delete(m.decisionId);
  log(SCOPE, `plan decision resolved ${m.decisionId}`, { decision: m.decision });
  pending.resolve({ decision: m.decision, editedSteps: m.editedSteps, feedback: m.feedback });
}

/* ───────── engine driver ───────── */

/** Build the shared tool executor for a session: gates `write` adapters behind
 * explicit user approval, then runs via the dispatcher. */
function makeExecuteTool(
  sessionId: string,
): (opts: { tool: string; args: Record<string, unknown> }) => Promise<ToolExecResult> {
  return async (opts) => {
    const adapter = lookupAdapter(opts.tool);
    if (adapter?.access === 'write') {
      const approved = await requestWriteConfirmation(
        sessionId,
        opts.tool,
        opts.args,
        adapter.description,
      );
      if (!approved) {
        return {
          ok: false,
          error: 'User declined to execute this write operation.',
          durationMs: 0,
        };
      }
    }
    return executeAdapter(opts) as Promise<ToolExecResult>;
  };
}

/** One-shot guard so we warn about disabled func adapters at most once per SW. */
let disabledFuncNoticeSent = false;

/** When Phase B (userScripts) is off but the user has func adapters installed,
 * a one-line note so the model + user know those site tools are unavailable
 * (instead of the model silently faking it with generic tools). */
async function disabledFuncAdapterNote(): Promise<string | null> {
  if (isUserScriptsApiAvailable()) return null;
  const rows = await listInstalledAdapters().catch(() => []);
  const funcRows = rows.filter((r) => r.enabled && (r.kind === 'func' || r.kind === 'mixed'));
  if (!funcRows.length) return null;
  const names = funcRows
    .slice(0, 6)
    .map((r) => r.title)
    .join('、');
  return `你安装的 ${funcRows.length} 个 adapter(${names}${funcRows.length > 6 ? '…' : ''})需要 Chrome 的「允许用户脚本」开关才能运行,当前未启用,这些站点的工具不可用。`;
}

/** Open a dedicated background tab and begin an explore trace session on it.
 * The agent's explore-aware open_url reuses this tab for all navigation. */
async function startExploreSession(task: string): Promise<ExploreSession> {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (typeof tab.id !== 'number') throw new Error('failed to open explore tab');
  const traceId = `explore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return ExploreSession.start({ traceId, tabId: tab.id, task });
}

/** Stop capture, then synthesize an adapter from the trace and surface the
 * result (or the reason it couldn't). Best-effort; never throws to the caller. */
async function finishExploreSession(
  sessionId: string,
  explore: ExploreSession,
  signal: AbortSignal,
): Promise<void> {
  const aborted = signal.aborted;
  await explore.stop(aborted ? 'aborted' : 'done');
  if (aborted) {
    sendToSidepanel({
      type: 'SESSION_NOTICE',
      sessionId,
      level: 'info',
      text: '探索已中断,未进行合成。',
    } satisfies SessionNoticeEvt);
    return;
  }
  await emitSynthForTrace(sessionId, explore.traceId);
}

/** Synthesize an adapter for a trace (optionally a repair pass that feeds back
 * the failing source + error) and push the result card to the panel. Keeps the
 * SW alive across the LLM round-trip. Shared by the post-run finish + the
 * panel's "根据报错重修" (P4 bounded repair). */
async function emitSynthForTrace(
  sessionId: string,
  traceId: string,
  repair?: { prevSource: string; error: string },
): Promise<void> {
  startKeepalivePing();
  try {
    const trace = await getTrace(traceId);
    const counts = {
      network: trace?.counts.network ?? 0,
      action: trace?.counts.action ?? 0,
      state: trace?.counts.state ?? 0,
    };
    const base: ExploreResultEvt = {
      type: 'EXPLORE_RESULT',
      sessionId,
      traceId,
      ok: false,
      counts,
    };
    if (!trace) {
      sendToSidepanel({
        ...base,
        error: 'trace 未找到(可能没捕获到任何数据)',
      } satisfies ExploreResultEvt);
      return;
    }
    const primary = (await resolveSlots().catch(() => null))?.primary;
    if (!primary?.apiKey || !primary.baseUrl) {
      sendToSidepanel({ ...base, error: '未配置主模型,无法合成适配器' } satisfies ExploreResultEvt);
      return;
    }
    const res = await synthesizeAdapter(
      trace,
      { apiKey: primary.apiKey, baseUrl: primary.baseUrl, model: primary.model },
      { repair },
    );
    sendToSidepanel({
      ...base,
      ok: res.ok,
      site: res.site,
      name: res.name,
      source: res.source,
      summary: res.summary,
      testArgs: res.testArgs,
      error: res.error,
    } satisfies ExploreResultEvt);
    log(
      SCOPE,
      `explore synth trace=${traceId}${repair ? '(repair)' : ''} → ${res.ok ? `${res.site}/${res.name}` : 'fail'}`,
    );
  } finally {
    stopKeepalivePingIfIdle();
  }
}

/** Panel-initiated bounded repair: re-synthesize feeding back the run error. */
async function handleExploreRepair(m: ExploreRepairReq): Promise<void> {
  await emitSynthForTrace(m.sessionId, m.traceId, { prevSource: m.prevSource, error: m.error });
}

/** Panel-initiated verify "试跑": run one read tool through the dispatcher and
 * return a compact result. Write adapters are refused (must go through the
 * normal in-conversation write-confirm). */
async function handleRunTool(m: RunToolReq): Promise<RunToolResp> {
  const adapter = lookupAdapter(m.tool);
  if (!adapter) return { type: 'RUN_TOOL_RESP', ok: false, error: `tool not found: ${m.tool}` };
  if (adapter.access === 'write') {
    return { type: 'RUN_TOOL_RESP', ok: false, error: '写操作不自动试跑,请在对话里手动执行确认。' };
  }
  startKeepalivePing();
  try {
    const r = (await executeAdapter({ tool: m.tool, args: m.args ?? {} })) as ToolExecResult;
    if (!r.ok) return { type: 'RUN_TOOL_RESP', ok: false, error: r.error };
    const rows = Array.isArray(r.result) ? r.result.length : undefined;
    let preview: string;
    try {
      // Return the full result (capped) so the panel can show it completely +
      // offer copy; large payloads are bounded to keep the message sane.
      preview = JSON.stringify(r.result, null, 2).slice(0, 200_000);
    } catch {
      preview = '[unserializable]';
    }
    return { type: 'RUN_TOOL_RESP', ok: true, rows, preview };
  } catch (e) {
    return { type: 'RUN_TOOL_RESP', ok: false, error: msgOf(e) };
  } finally {
    stopKeepalivePingIfIdle();
  }
}

async function driveApiSession(
  session: SessionState,
  userText: string,
  mode?: 'chat' | 'plan' | 'explore',
): Promise<void> {
  const abortCtl = new AbortController();
  activeSessions.set(session.id, { session, abort: abortCtl });
  startKeepalivePing(); // pin the SW for the whole turn (see startKeepalivePing)
  const envNote = await disabledFuncAdapterNote();
  if (envNote && !disabledFuncNoticeSent) {
    disabledFuncNoticeSent = true;
    sendToSidepanel({
      type: 'SESSION_NOTICE',
      sessionId: session.id,
      level: 'warning',
      text: `${envNote} 在 chrome://extensions 打开本扩展的该开关并重载扩展即可启用。`,
    } satisfies SessionNoticeEvt);
  }

  // Explore mode: open a dedicated tab + begin trace capture BEFORE the run, so
  // the agent's open_url reuses it and the session-wide network capture is live
  // for the whole task. Synthesis runs after the loop (finishExploreSession).
  let explore: ExploreSession | null = null;
  let runMode: 'chat' | 'plan' | 'explore' = mode ?? 'chat';
  if (runMode === 'explore') {
    try {
      explore = await startExploreSession(userText);
      sendToSidepanel({
        type: 'SESSION_NOTICE',
        sessionId: session.id,
        level: 'info',
        text: `🔍 探索已开始(trace ${explore.traceId})。我会在真实页面上把任务做一遍并全程录制,完成后自动尝试合成一个可复用的适配器。`,
      } satisfies SessionNoticeEvt);
    } catch (e) {
      logError(SCOPE, 'explore start failed', e);
      sendToSidepanel({
        type: 'SESSION_NOTICE',
        sessionId: session.id,
        level: 'warning',
        text: `无法启动探索:${msgOf(e)} —— 改为普通执行。`,
      } satisfies SessionNoticeEvt);
      runMode = 'chat';
    }
  }

  const ctx: EngineContext = {
    session,
    userText,
    signal: abortCtl.signal,
    mode: runMode,
    environmentNote: envNote ?? undefined,
    emit: (evt) => forwardOrchEvent(session.id, evt),
    executeTool: makeExecuteTool(session.id),
    requestPlanDecision: (plan) => requestPlanDecision(session.id, plan),
    takeSteerMessages: () => {
      const q = steerQueue.get(session.id);
      if (!q || q.length === 0) return [];
      steerQueue.delete(session.id);
      return q;
    },
  };
  try {
    await apiEngine.run(ctx);
  } catch (e) {
    logError(SCOPE, 'apiEngine.run threw', e);
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: session.id,
      reason: 'error',
      error: msgOf(e),
    } satisfies SessionDoneEvt);
  } finally {
    // Finalize the explore trace + synthesize BEFORE we drop the session from
    // activeSessions (which would let the keepalive ping stop) — synthesis is
    // another LLM round-trip and needs the SW alive.
    if (explore) {
      try {
        await finishExploreSession(session.id, explore, abortCtl.signal);
      } catch (e) {
        logError(SCOPE, 'explore finish failed', e);
      }
    }
    activeSessions.delete(session.id);
    // Backstop (§10.14): a steer can still be in the queue here — it landed
    // after the engine's last drain, via a finish path that doesn't re-drain
    // (checkpoint / error / abort) OR the microtask race against this cleanup.
    // Don't drop it: re-drive it as a follow-up turn so it's persisted +
    // answered instead of vanishing on reload.
    const leftoverSteers = steerQueue.get(session.id) ?? [];
    steerQueue.delete(session.id);
    stopKeepalivePingIfIdle(); // release the SW once no session is running
    await saveSession(session);
    if (leftoverSteers.length) {
      log(SCOPE, `re-driving ${leftoverSteers.length} leftover steer(s) for ${session.id}`);
      void rerouteSteerAsFollowUp({
        type: 'STEER_MESSAGE',
        sessionId: session.id,
        text: leftoverSteers.join('\n'),
      });
    }
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function forwardOrchEvent(sessionId: string, evt: OrchEvent): void {
  switch (evt.type) {
    case 'assistant_turn': {
      const out: AssistantTurnEvt = {
        type: 'ASSISTANT_TURN',
        sessionId,
        iteration: evt.iteration,
        cleanedText: evt.cleanedText,
        rawText: evt.rawText,
        reasoningText: evt.reasoningText,
        commands: evt.commands,
      };
      sendToSidepanel(out);
      break;
    }
    case 'assistant_delta': {
      const out: AssistantTurnPatchEvt = {
        type: 'ASSISTANT_TURN_PATCH',
        sessionId,
        iteration: evt.iteration,
        text: evt.text,
      };
      sendToSidepanel(out);
      break;
    }
    case 'run_stats': {
      const out: RunStatsEvt = {
        type: 'RUN_STATS',
        sessionId,
        step: evt.step,
        promptTokens: evt.promptTokens,
        completionTokens: evt.completionTokens,
      };
      sendToSidepanel(out);
      break;
    }
    case 'tool_trace': {
      const out: ToolTraceEvt = { type: 'TOOL_TRACE', sessionId, trace: evt.trace };
      sendToSidepanel(out);
      break;
    }
    case 'iteration_progress': {
      const out: IterationProgressEvt = {
        type: 'ITERATION_PROGRESS',
        sessionId,
        iterationId: evt.iterationId,
        iteration: evt.iteration,
        phase: evt.phase,
        textLen: evt.textLen,
      };
      sendToSidepanel(out);
      break;
    }
    case 'session_done': {
      const out: SessionDoneEvt = {
        type: 'SESSION_DONE',
        sessionId,
        reason: evt.reason,
        error: evt.error,
      };
      sendToSidepanel(out);
      break;
    }
    case 'notice': {
      const out: SessionNoticeEvt = {
        type: 'SESSION_NOTICE',
        sessionId,
        level: evt.level,
        text: evt.text,
      };
      sendToSidepanel(out);
      break;
    }
    case 'plan_updated': {
      const out: PlanUpdatedEvt = { type: 'PLAN_UPDATED', sessionId, plan: evt.plan };
      sendToSidepanel(out);
      break;
    }
  }
}

function sendToSidepanel(m: Message): void {
  // chrome.runtime.sendMessage from SW delivers to all extension pages
  // (sidepanel, popup), but NOT back to SW itself. SidePanel filters by type.
  void chrome.runtime.sendMessage(m).catch(() => {
    // No listener (e.g. sidepanel closed). Not fatal.
  });
}
