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
import type {
  AbortSessionReq,
  SteerMessageReq,
  AssistantTurnEvt,
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
    default:
      return;
  }
});

/* ───────── handlers ───────── */

async function handleUserMessage(m: UserMessageReq): Promise<void> {
  log(SCOPE, `USER_MESSAGE sessionId=${m.sessionId}`, { text: m.text.slice(0, 80) });
  if (activeSessions.has(m.sessionId)) {
    sendErrorDone(m.sessionId, `session ${m.sessionId} is already running`);
    return;
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

/** Queue a steering message for a running session (the engine drains it on its
 * next turn). Ignored if the session isn't currently being driven. */
function handleSteer(m: SteerMessageReq): void {
  if (!activeSessions.has(m.sessionId)) return;
  const q = steerQueue.get(m.sessionId) ?? [];
  q.push(m.text);
  steerQueue.set(m.sessionId, q);
  log(SCOPE, `steer queued for ${m.sessionId}`, { pending: q.length });
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
  return new Promise<PlanDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingPlanDecisions.has(decisionId)) return;
      pendingPlanDecisions.delete(decisionId);
      warn(SCOPE, `plan-decision timeout ${decisionId}`);
      resolve({ decision: 'reject' });
    }, PLAN_DECISION_TIMEOUT_MS);
    pendingPlanDecisions.set(decisionId, {
      resolve: (d: PlanDecision) => {
        clearTimeout(timer);
        resolve(d);
      },
    });
    const req: PlanDecisionReq = { type: 'PLAN_DECISION_REQ', sessionId, decisionId, plan };
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

async function driveApiSession(
  session: SessionState,
  userText: string,
  mode?: 'chat' | 'plan',
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
  const ctx: EngineContext = {
    session,
    userText,
    signal: abortCtl.signal,
    mode,
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
    activeSessions.delete(session.id);
    steerQueue.delete(session.id);
    stopKeepalivePingIfIdle(); // release the SW once no session is running
    await saveSession(session);
  }
}

function sendErrorDone(sessionId: string, error: string): void {
  sendToSidepanel({
    type: 'SESSION_DONE',
    sessionId,
    reason: 'error',
    error,
  } satisfies SessionDoneEvt);
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
