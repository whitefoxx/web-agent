/**
 * Service worker — central message router + agent orchestrator host.
 *
 * Responsibilities:
 *   - Import all xiaohongshu adapters (their top-level cli({...}) registers them).
 *   - Open side panel on toolbar action click.
 *   - Route messages between SidePanel ↔ DeepSeek connector ↔ Tool dispatcher.
 *   - Run the agent orchestrator for each user message, fire-and-forget so the
 *     SidePanel's `sendMessage` ack returns immediately (the message channel
 *     would otherwise be held open for the entire ~minutes-long session and
 *     break if Chrome recycles the SW).
 *   - Track which DeepSeek tab each session is bound to, watch for that tab
 *     being closed / navigated away / switched to a different conversation,
 *     and pause the session (preserving its pendingPrompt) so the user can
 *     Resume later.
 *   - Aggregate logs forwarded from other contexts.
 */

import { log, warn, error as logError, ingestEntry, getLocalBuffer } from '../runtime/log';
import {
  runSession,
  TabUnavailableError,
  type ChatbotResponse,
  type Driver,
  type OrchEvent,
  type ToolExecResult,
} from '../agent/orchestrator';
import {
  deleteSession,
  isDeepseekIdleUrl,
  listSessions,
  loadSession,
  makeSession,
  parseConversationUrl,
  saveSession,
  type SessionState,
} from '../agent/session';
import { executeAdapter } from '../tools/dispatcher';
import { lookupAdapter } from '../tools/manifest';
import { loadLlmConfig } from '../config/llm-config';
import { apiEngine } from '../agent/api-engine';
import type { EngineContext } from '../agent/engine';
import type {
  AbortSessionReq,
  AssistantTurnEvt,
  ChatbotBusyEvt,
  ChatbotErrorEvt,
  ChatbotResponseEvt,
  ChatbotStreamingEvt,
  ChatbotTabStatusEvt,
  ConnectorReadyEvt,
  DeleteSessionReq,
  DiscardSessionReq,
  EnsureChatbotTabReq,
  GetSessionReq,
  GetSessionResp,
  InjectPromptReq,
  IterationProgressEvt,
  ListSessionsReq,
  ListSessionsResp,
  LogEntryEvt,
  LogsResponse,
  Message,
  RequestLogsReq,
  ResumeSessionReq,
  SessionDoneEvt,
  SessionNoticeEvt,
  SessionPausedEvt,
  SessionSummary,
  ToolTraceEvt,
  UserMessageReq,
  WriteConfirmReq,
  WriteConfirmResp,
} from '../connectors/messages';

// Side-effect imports: each adapter file's top-level cli({...}) registers it
// with the global registry that openAiToolsFromRegistry / lookupAdapter read.
import '../tools/xiaohongshu/_all';
import '../tools/generic/_all';
// Unmodified opencli adapter, byte-imported via scripts/import-adapter.mjs.
// Its `@jackwener/opencli/*` imports resolve through the Vite alias to our
// shims — proof of source-level opencli compatibility.
import '../tools/hackernews/_all';

// Runtime-installed adapters (hot-plug): registered from IndexedDB on boot,
// and installed/uninstalled at runtime via the message router below.
import {
  installFromCaptured,
  loadInstalledOnBoot,
  uninstall as uninstallAdapter,
  setEnabled as setAdapterEnabled,
  listInstalledAdapters,
} from '../adapters/install-manager';
import type {
  InstallAdapterReq,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  ListInstalledResp,
  InstalledAdapterSummary,
  AdaptersChangedEvt,
} from '../connectors/messages';

const SCOPE = 'sw';

/* ───────── runtime state (lost on SW termination) ───────── */

interface ActiveSession {
  session: SessionState;
  abort: AbortController;
}

interface TabInfo {
  url: string;
  loggedIn: boolean;
}

/** All currently-known deepseek tabs and what we last heard about them. */
const knownTabs = new Map<number, TabInfo>();

/** Sessions currently being driven by an orchestrator. Cleared when finished
 * / paused / aborted. The session object itself is also persisted via
 * chrome.storage.session — restart-safe state lives in `SessionState`. */
const activeSessions = new Map<string, ActiveSession>();

/** Connector → SW response routing, keyed by iterationId. The SW driver
 * sets these from `waitForResponse`; the connector resolves them via
 * CHATBOT_RESPONSE / rejects via CHATBOT_ERROR / via SESSION_PAUSED side-
 * channel when the bound tab vanishes. */
const pendingResponses = new Map<
  string,
  { resolve: (r: ChatbotResponse) => void; reject: (e: Error) => void; tabId: number }
>();

/** SidePanel-bound write-confirm prompts. Resolves true on approval,
 * false on decline / timeout / panel close. */
const pendingConfirmations = new Map<string, { resolve: (approved: boolean) => void }>();
const WRITE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** Open keep-alive ports from extension pages (SidePanel). As long as one
 * is connected, Chrome MV3 won't recycle this service worker, which is
 * what was orphaning long-running orchestrator iterations: DeepSeek
 * thinking phases routinely run >30s with no chrome.* activity, the SW
 * would be killed, `pendingResponses` / `activeSessions` would vanish,
 * and the next CHATBOT_RESPONSE arriving after wake-up would be
 * silently dropped as "unmatched" — leaving the SidePanel stuck on the
 * "正在生成" banner and unable to abort. */
const keepaliveConnections = new Set<chrome.runtime.Port>();

/* ───────── lifecycle ───────── */

log(SCOPE, 'service worker booting');
void recoverInterruptedSessionsOnBoot();
// Restore runtime-installed adapters into the live registry. Fire-and-forget:
// boot shouldn't block on IDB, and a brand-new install has nothing to restore.
void loadInstalledOnBoot().catch((e) => warn(SCOPE, 'loadInstalledOnBoot failed', e));

chrome.runtime.onInstalled.addListener(() => {
  log(SCOPE, 'onInstalled');
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => warn(SCOPE, 'setPanelBehavior failed', e));
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webchat-keepalive') return;
  keepaliveConnections.add(port);
  log(SCOPE, `keepalive port connected (total=${keepaliveConnections.size})`);
  port.onDisconnect.addListener(() => {
    keepaliveConnections.delete(port);
    log(SCOPE, `keepalive port disconnected (remaining=${keepaliveConnections.size})`);
  });
});

/** On boot, find any persisted session whose status was 'running' at the
 * moment the prior SW instance died and mark it as 'error'. Its in-
 * memory pendingResponses / activeSessions entries are gone with the
 * worker, so the orchestrator can't continue from where it left off —
 * the user has to retry the last message. We push SESSION_DONE so the
 * SidePanel clears any stale "正在生成" / "DeepSeek 思考中" banner. */
async function recoverInterruptedSessionsOnBoot(): Promise<void> {
  try {
    const sessions = await listSessions({ status: 'running' });
    for (const s of sessions) {
      log(SCOPE, `recovering interrupted session ${s.id}`);
      s.status = 'error';
      s.pendingPrompt = null;
      s.pauseReason = null;
      await saveSession(s);
      sendToSidepanel({
        type: 'SESSION_DONE',
        sessionId: s.id,
        reason: 'error',
        error:
          '会话因扩展后台被回收而中断了。再发一句话可以接着聊（基于之前的 DeepSeek conversation），或在历史抽屉里点"打开"重新拉起这条会话。',
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!knownTabs.has(tabId)) return;
  log(SCOPE, `deepseek tab=${tabId} removed`);
  knownTabs.delete(tabId);
  // Any session bound to this tab transitions to paused.
  for (const entry of activeSessions.values()) {
    if (entry.session.chatbotTabId === tabId) {
      rejectPendingForTab(tabId, 'tab_closed', 'tab was closed by the user');
    }
  }
  broadcastChatbotStatusForAnyTab();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && !info.status) return;
  // Track URL of any deepseek tab we already know.
  const wasKnown = knownTabs.has(tabId);
  const url = info.url ?? tab.url ?? '';
  if (!url.startsWith('https://chat.deepseek.com')) {
    if (wasKnown) {
      log(SCOPE, `deepseek tab=${tabId} navigated away to ${url}`);
      knownTabs.delete(tabId);
      rejectPendingForTab(tabId, 'tab_navigated_away', `navigated to ${url}`);
      broadcastChatbotStatusForAnyTab();
    }
    return;
  }
  // Still a deepseek URL — update known state.
  const prev = knownTabs.get(tabId);
  knownTabs.set(tabId, { url, loggedIn: prev?.loggedIn ?? false });
  if (!info.url) return; // only treat real URL changes as conv-change signals

  // If any session was pinned to this tab AND a conv-id, see if it moved.
  for (const entry of activeSessions.values()) {
    const s = entry.session;
    if (s.chatbotTabId !== tabId || !s.conversationId) continue;
    const parsed = parseConversationUrl(url);
    if (!parsed || parsed.conversationId !== s.conversationId) {
      log(SCOPE, `session=${s.id} bound tab=${tabId} moved off conv ${s.conversationId}`, {
        newUrl: url,
      });
      rejectPendingForTab(tabId, 'conv_mismatch', `tab now at ${url}`);
    }
  }
});

/* ───────── message router ───────── */

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse): boolean | undefined => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Message;
  switch (m.type) {
    case 'USER_MESSAGE': {
      // Early-ack: the message channel returns immediately so the SidePanel
      // is not blocked for the whole session. Progress is reported via
      // ASSISTANT_TURN / TOOL_TRACE / ITERATION_PROGRESS / SESSION_PAUSED /
      // SESSION_DONE events instead.
      const r = m as UserMessageReq;
      sendResponse({ ok: true });
      void handleUserMessage(r);
      return false;
    }
    case 'RESUME_SESSION': {
      sendResponse({ ok: true });
      void handleResume(m as ResumeSessionReq);
      return false;
    }
    case 'DISCARD_SESSION': {
      void handleDiscard(m as DiscardSessionReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'ABORT_SESSION': {
      handleAbort(m as AbortSessionReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'ENSURE_CHATBOT_TAB': {
      void handleEnsureTab(m as EnsureChatbotTabReq).then(
        (st) => sendResponse(st),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;
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
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;
    }
    case 'GET_SESSION': {
      void handleGetSession(m as GetSessionReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;
    }
    case 'DELETE_SESSION': {
      void handleDeleteSession(m as DeleteSessionReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;
    }
    case 'CONNECTOR_READY': {
      handleConnectorReady(m as ConnectorReadyEvt, sender);
      return false;
    }
    case 'INJECT_ACK': {
      log(SCOPE, 'INJECT_ACK', m);
      return false;
    }
    case 'CHATBOT_RESPONSE': {
      handleChatbotResponse(m as ChatbotResponseEvt);
      return false;
    }
    case 'CHATBOT_BUSY': {
      sendToSidepanel(m as ChatbotBusyEvt);
      return false;
    }
    case 'CHATBOT_STREAMING': {
      sendToSidepanel(m as ChatbotStreamingEvt);
      return false;
    }
    case 'CHATBOT_ERROR': {
      handleChatbotError(m as ChatbotErrorEvt);
      return false;
    }
    case 'WRITE_CONFIRM_RESP': {
      handleWriteConfirmResp(m as WriteConfirmResp);
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
      return true; // async sendResponse
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
  let session = await loadSession(m.sessionId);
  const isFreshSession = !session;
  if (!session) session = makeSession(m.sessionId);

  if (session.status === 'paused') {
    sendErrorDone(
      m.sessionId,
      'session is paused. Resume it or discard before sending a new message.',
    );
    return;
  }

  // LLM backend selection. In `api` mode we don't need a chatbot tab at all —
  // tool calls are native and resolve their own per-site tabs via the
  // dispatcher. Branch here, before any DeepSeek-tab plumbing.
  const llmConfig = await loadLlmConfig();
  if (llmConfig.mode === 'api') {
    await driveApiSession(session, m.text);
    return;
  }

  // 1) Continuation case: this is a follow-up message and the original
  //    DeepSeek tab is still alive on the right conversation. Reuse it so
  //    the chatbot keeps full context.
  const reusedTabId = await tryReuseSessionTab(session);
  if (reusedTabId !== null) {
    log(SCOPE, `continuation on session=${session.id} reusing tab=${reusedTabId}`);
    session.chatbotTabId = reusedTabId;
    await driveSession(session, m.text, /* resume */ false, /* continuation */ true);
    return;
  }

  // 2) Reattach case: the bound tab is gone / moved, BUT we still remember
  //    the DeepSeek conversation URL. Open it in a fresh tab. DeepSeek
  //    usually serves the conv history from the server side per URL,
  //    letting us pick up exactly where we left off in continuation mode.
  //
  //    Edge case: if the user (or DeepSeek's GC) DELETED that conv server-
  //    side, hitting `/a/chat/s/<deletedId>` redirects to the homepage
  //    `/`. The new DeepSeek conv knows nothing about our protocol — so
  //    in that case we must downgrade to a full system-prompt injection
  //    instead of the bare-userText+reminder of continuation mode.
  if (session.conversationUrl) {
    log(SCOPE, `session=${session.id} bound tab dead — re-opening conv URL`, {
      conversationUrl: session.conversationUrl,
    });
    const reopened = await openOrFocusTab(session.conversationUrl);
    if (reopened !== null) {
      session.chatbotTabId = reopened;
      const landed = await landedConvIdFor(reopened);
      if (landed && landed === session.conversationId) {
        log(SCOPE, `re-attached to surviving conv ${session.conversationId}`);
        await driveSession(session, m.text, /* resume */ false, /* continuation */ true);
      } else {
        log(
          SCOPE,
          `conv ${session.conversationId} no longer exists; downgrading to fresh first-turn prompt in same SidePanel session`,
          { landedConv: landed },
        );
        sendToSidepanel({
          type: 'SESSION_NOTICE',
          sessionId: session.id,
          level: 'warning',
          text: '原 DeepSeek 会话已不可用（可能被你在 deepseek 站点上删除了），系统已自动开启一个新 DeepSeek 会话并附带完整工具协议。后续追问会沿用这个新会话。',
        } satisfies SessionNoticeEvt);
        // Clear stale binding. handleChatbotResponse will capture the new
        // conversationId/Url from the first CHATBOT_RESPONSE's currentUrl,
        // re-binding this session to the freshly-created DeepSeek conv.
        session.conversationId = null;
        session.conversationUrl = null;
        session.turnsSinceFullPrompt = 0;
        await driveSession(session, m.text, /* resume */ false, /* continuation */ false);
      }
      return;
    }
    warn(SCOPE, `failed to re-open conv URL for session=${session.id}`);
  }

  // 3) Fresh-session case: no usable binding, no recoverable conv URL.
  //    Pick an idle tab (or open one) and start over.
  if (!isFreshSession && (session.conversationId || session.chatbotTabId)) {
    log(SCOPE, `session=${session.id} bound tab/conv stale, starting fresh`, {
      tabId: session.chatbotTabId,
      conversationId: session.conversationId,
    });
  }
  const tabId = await pickTabForNewSession();
  if (tabId === null) {
    sendErrorDone(m.sessionId, 'No DeepSeek tab available. Open https://chat.deepseek.com first.');
    return;
  }
  session.chatbotTabId = tabId;
  session.conversationId = null;
  session.conversationUrl = null;
  const url = knownTabs.get(tabId)?.url ?? '';
  const conv = parseConversationUrl(url);
  if (conv) {
    session.conversationId = conv.conversationId;
    session.conversationUrl = conv.conversationUrl;
  }

  await driveSession(session, m.text, /* resume */ false, /* continuation */ false);
}

/** Poll a tab's URL until it's been the same for `quietMs`, or `maxMs`
 * elapses. Returns the last URL observed. Used after openOrFocusTab to
 * defeat the race against DeepSeek's client-side redirect when the conv
 * we're trying to reattach to was deleted: the tab is created at
 * /a/chat/s/<deletedId>, the SPA mounts, fetches the conv, gets a 404,
 * and only then history.replaceState('/'). A naive chrome.tabs.get()
 * straight after openOrFocusTab catches the URL pre-redirect ~70% of
 * the time and falsely concludes "conv survived". */
async function waitForTabUrlStable(
  tabId: number,
  opts: { quietMs?: number; maxMs?: number } = {},
): Promise<string> {
  const quietMs = opts.quietMs ?? 800;
  const maxMs = opts.maxMs ?? 4000;
  const t0 = Date.now();
  let lastUrl = '';
  let lastChangeAt = Date.now();
  while (Date.now() - t0 < maxMs) {
    let url: string;
    try {
      const t = await chrome.tabs.get(tabId);
      url = t.url ?? '';
    } catch {
      return lastUrl;
    }
    if (url !== lastUrl) {
      lastUrl = url;
      lastChangeAt = Date.now();
    } else if (url && Date.now() - lastChangeAt >= quietMs) {
      return url;
    }
    await sleep(150);
  }
  return lastUrl;
}

/** Wait for the tab URL to settle, then return the conversationId visible
 * there (or null for homepage / non-conv URLs). The wait is what makes
 * this robust against DeepSeek's deleted-conv redirect race. */
async function landedConvIdFor(tabId: number): Promise<string | null> {
  const stableUrl = await waitForTabUrlStable(tabId);
  return parseConversationUrl(stableUrl)?.conversationId ?? null;
}

/** Returns the session's existing chatbot tab id if all of these hold:
 *   - session.chatbotTabId is set
 *   - that tab still exists
 *   - tab's current URL still points at session.conversationId (i.e. the
 *     user hasn't switched the tab to another chat / navigated away)
 *   - content script is responsive (or can be re-injected). */
async function tryReuseSessionTab(session: SessionState): Promise<number | null> {
  if (typeof session.chatbotTabId !== 'number') return null;
  if (!session.conversationId) return null;
  if (!(await tabStillExists(session.chatbotTabId))) return null;
  let url = knownTabs.get(session.chatbotTabId)?.url ?? '';
  if (!url) {
    try {
      const tab = await chrome.tabs.get(session.chatbotTabId);
      url = tab.url ?? '';
      knownTabs.set(session.chatbotTabId, { url, loggedIn: false });
    } catch {
      return null;
    }
  }
  const conv = parseConversationUrl(url);
  if (!conv || conv.conversationId !== session.conversationId) return null;
  if (!(await ensureContentScriptInjected(session.chatbotTabId))) return null;
  return session.chatbotTabId;
}

async function handleResume(m: ResumeSessionReq): Promise<void> {
  const session = await loadSession(m.sessionId);
  if (!session) {
    sendErrorDone(m.sessionId, `session ${m.sessionId} not found`);
    return;
  }
  if (session.status !== 'paused') {
    log(SCOPE, `RESUME on non-paused session=${m.sessionId} (status=${session.status})`);
    return;
  }
  if (!session.conversationUrl) {
    sendErrorDone(m.sessionId, 'session has no conversationUrl to resume from');
    return;
  }
  log(SCOPE, `RESUME session=${m.sessionId} → ${session.conversationUrl}`);
  // Reuse an existing tab on the same conversation if possible.
  const tabId = await openOrFocusTab(session.conversationUrl);
  if (tabId === null) {
    sendErrorDone(m.sessionId, 'failed to open / focus the conversation tab');
    return;
  }
  session.chatbotTabId = tabId;
  // If the user manually deleted the conv between Pause and Resume,
  // pendingPrompt was constructed for the old DeepSeek context (e.g. a
  // tool-result follow-up) and re-injecting it into a fresh chat would
  // confuse DeepSeek. Replay the original user message with the full
  // system prompt instead.
  const landed = await landedConvIdFor(tabId);
  if (landed && landed === session.conversationId) {
    await driveSession(
      session,
      session.pendingPrompt ?? '',
      /* resume */ true,
      /* continuation */ false,
    );
  } else {
    log(SCOPE, `Resume: conv ${session.conversationId} lost; replaying first user turn`, {
      landedConv: landed,
    });
    sendToSidepanel({
      type: 'SESSION_NOTICE',
      sessionId: session.id,
      level: 'warning',
      text: '原 DeepSeek 会话已不可用（可能在 deepseek 站点上被删除了），无法接着 pendingPrompt 继续。已自动重新发起原始问题并带完整协议，等同于在新会话里从头开始。',
    } satisfies SessionNoticeEvt);
    const firstUser = session.history.find((t) => t.role === 'user');
    session.conversationId = null;
    session.conversationUrl = null;
    session.pendingPrompt = null;
    session.turnsSinceFullPrompt = 0;
    if (firstUser) {
      // Clear stale transcript so the replay starts clean in the same
      // SidePanel slot; old turns aren't displayed but stay logged in
      // earlier IDB snapshots / log entries for forensics.
      session.history = [];
      session.iterations = 0;
      await driveSession(session, firstUser.text, /* resume */ false, /* continuation */ false);
    } else {
      sendErrorDone(m.sessionId, '原 DeepSeek 会话已被删除，且找不到首条用户消息可重放。');
    }
  }
}

async function handleDiscard(m: DiscardSessionReq): Promise<void> {
  log(SCOPE, `DISCARD session=${m.sessionId}`);
  const entry = activeSessions.get(m.sessionId);
  if (entry) {
    entry.abort.abort();
    activeSessions.delete(m.sessionId);
  }
  const s = await loadSession(m.sessionId);
  if (!s) return;
  s.status = 'aborted';
  s.pendingPrompt = null;
  s.pauseReason = null;
  await saveSession(s);
  sendToSidepanel({
    type: 'SESSION_DONE',
    sessionId: m.sessionId,
    reason: 'user_abort',
  } satisfies SessionDoneEvt);
}

function handleAbort(m: AbortSessionReq): void {
  const entry = activeSessions.get(m.sessionId);
  if (!entry) return;
  log(SCOPE, `aborting session ${m.sessionId}`);
  entry.abort.abort();
  for (const [iter, p] of pendingResponses) {
    if (iter.startsWith(m.sessionId)) {
      pendingResponses.delete(iter);
      p.reject(new Error('aborted'));
    }
  }
}

async function handleEnsureTab(_m: EnsureChatbotTabReq): Promise<ChatbotTabStatusEvt> {
  const tabId = await findAnyDeepseekTab();
  if (tabId === null) {
    return {
      type: 'CHATBOT_TAB_STATUS',
      chatbot: 'deepseek',
      tabId: null,
      ready: false,
      loggedIn: false,
    };
  }
  await ensureContentScriptInjected(tabId);
  const info = knownTabs.get(tabId);
  return {
    type: 'CHATBOT_TAB_STATUS',
    chatbot: 'deepseek',
    tabId,
    ready: !!info?.loggedIn,
    loggedIn: !!info?.loggedIn,
    url: info?.url,
  };
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
    conversationId: s.conversationId,
    conversationUrl: s.conversationUrl,
    pauseReason: s.pauseReason ?? null,
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

function handleConnectorReady(m: ConnectorReadyEvt, sender: chrome.runtime.MessageSender): void {
  if (!sender.tab?.id) return;
  const tabId = sender.tab.id;
  log(SCOPE, `CONNECTOR_READY tab=${tabId}`, { loggedIn: m.loggedIn, url: m.url });
  knownTabs.set(tabId, { url: m.url, loggedIn: m.loggedIn });
  broadcastChatbotStatusForAnyTab();
}

function handleChatbotResponse(m: ChatbotResponseEvt): void {
  const pending = pendingResponses.get(m.iterationId);
  if (!pending) {
    warn(SCOPE, `unmatched CHATBOT_RESPONSE iteration=${m.iterationId}`);
    return;
  }
  pendingResponses.delete(m.iterationId);
  // Capture conversation id/URL on the session, if available + new.
  const conv = parseConversationUrl(m.currentUrl);
  if (conv) {
    for (const entry of activeSessions.values()) {
      const s = entry.session;
      if (s.chatbotTabId !== pending.tabId) continue;
      if (s.conversationId !== conv.conversationId || s.conversationUrl !== conv.conversationUrl) {
        log(SCOPE, `session=${s.id} captured conv`, conv);
        s.conversationId = conv.conversationId;
        s.conversationUrl = conv.conversationUrl;
        void saveSession(s);
      }
    }
  }
  pending.resolve({
    rawText: m.rawText,
    cleanedText: m.cleanedText,
    reasoningText: m.reasoningText,
    commands: m.commands,
    currentUrl: m.currentUrl,
  });
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

function handleChatbotError(m: ChatbotErrorEvt): void {
  const pending = pendingResponses.get(m.iterationId);
  if (!pending) {
    warn(SCOPE, `unmatched CHATBOT_ERROR iteration=${m.iterationId}`);
    return;
  }
  pendingResponses.delete(m.iterationId);
  const msg =
    m.reason === 'busy_exhausted'
      ? `DeepSeek server busy after multiple retries — ${m.message ?? ''}`.trim()
      : m.reason === 'stopped_exhausted'
        ? `DeepSeek stopped generation repeatedly — ${m.message ?? ''}`.trim()
        : m.reason === 'timeout'
          ? `DeepSeek response timeout — ${m.message ?? ''}`.trim()
          : `Chatbot error — ${m.message ?? '(unknown)'}`;
  pending.reject(new Error(msg));
}

/* ───────── orchestrator runner ───────── */

async function driveSession(
  session: SessionState,
  userText: string,
  resume: boolean,
  continuation: boolean,
): Promise<void> {
  if (typeof session.chatbotTabId !== 'number') {
    sendErrorDone(session.id, 'driveSession called without a bound tab');
    return;
  }
  const tabId = session.chatbotTabId;
  const abortCtl = new AbortController();
  activeSessions.set(session.id, { session, abort: abortCtl });

  const driver = makeDriver(session.id, tabId);
  try {
    await runSession({
      session,
      userText,
      driver,
      signal: abortCtl.signal,
      resume,
      continuation,
    });
  } catch (e) {
    logError(SCOPE, 'runSession threw', e);
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: session.id,
      reason: 'error',
      error: String(e instanceof Error ? e.message : e),
    } satisfies SessionDoneEvt);
  } finally {
    activeSessions.delete(session.id);
    await saveSession(session);
  }
}

/** API-mode session runner. No chatbot tab: the api engine talks to an
 * OpenAI-compatible endpoint and runs tools through the shared dispatcher
 * (which resolves its own per-site tabs). Emits the same OrchEvent UI stream
 * as the connector path via forwardOrchEvent. */
async function driveApiSession(session: SessionState, userText: string): Promise<void> {
  const abortCtl = new AbortController();
  activeSessions.set(session.id, { session, abort: abortCtl });
  const ctx: EngineContext = {
    session,
    userText,
    signal: abortCtl.signal,
    emit: (evt) => forwardOrchEvent(session.id, evt),
    executeTool: makeExecuteTool(session.id),
  };
  try {
    await apiEngine.run(ctx);
  } catch (e) {
    logError(SCOPE, 'apiEngine.run threw', e);
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: session.id,
      reason: 'error',
      error: String(e instanceof Error ? e.message : e),
    } satisfies SessionDoneEvt);
  } finally {
    activeSessions.delete(session.id);
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

/* ───────── tab management ───────── */

async function pickTabForNewSession(): Promise<number | null> {
  // 1. Prefer a known tab that is at the deepseek homepage (no /a/chat/s/<uuid>).
  for (const [tabId, info] of knownTabs) {
    if (!isDeepseekIdleUrl(info.url)) continue;
    if (isTabBoundToAnySession(tabId)) continue;
    if (!(await tabStillExists(tabId))) {
      knownTabs.delete(tabId);
      continue;
    }
    log(SCOPE, `pickTab: reusing idle known tab=${tabId}`);
    await ensureContentScriptInjected(tabId);
    return tabId;
  }
  // 2. Query browser for any idle deepseek tab that we haven't seen yet.
  const candidates = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  for (const c of candidates) {
    if (typeof c.id !== 'number') continue;
    if (isTabBoundToAnySession(c.id)) continue;
    if (!isDeepseekIdleUrl(c.url)) continue;
    log(SCOPE, `pickTab: claiming unseen idle tab=${c.id}`);
    knownTabs.set(c.id, { url: c.url ?? '', loggedIn: false });
    await ensureContentScriptInjected(c.id);
    return c.id;
  }
  // 3. Last resort: open a new tab.
  log(SCOPE, 'pickTab: opening fresh deepseek tab');
  const t = await chrome.tabs.create({ url: 'https://chat.deepseek.com/', active: false });
  if (typeof t.id !== 'number') return null;
  knownTabs.set(t.id, { url: t.url ?? '', loggedIn: false });
  await waitForConnectorReady(t.id, 60_000);
  return t.id;
}

async function openOrFocusTab(url: string): Promise<number | null> {
  // Reuse an existing tab at the same conversation if any.
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  const targetConv = parseConversationUrl(url)?.conversationId;
  if (targetConv) {
    for (const t of tabs) {
      if (typeof t.id !== 'number') continue;
      const conv = parseConversationUrl(t.url)?.conversationId;
      if (conv === targetConv) {
        log(SCOPE, `openOrFocus: reusing existing tab=${t.id} already on conv`);
        if (t.windowId !== undefined) {
          void chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
        void chrome.tabs.update(t.id, { active: true }).catch(() => {});
        await ensureContentScriptInjected(t.id);
        return t.id;
      }
    }
  }
  // Otherwise open a new tab at the conversation URL.
  const created = await chrome.tabs.create({ url, active: true });
  if (typeof created.id !== 'number') return null;
  knownTabs.set(created.id, { url, loggedIn: false });
  await waitForConnectorReady(created.id, 60_000);
  return created.id;
}

async function findAnyDeepseekTab(): Promise<number | null> {
  // Prefer a logged-in tab from our known map, then any known tab, then
  // fall back to a fresh chrome.tabs.query.
  for (const [tabId, info] of knownTabs) {
    if (!info.loggedIn) continue;
    if (await tabStillExists(tabId)) return tabId;
    knownTabs.delete(tabId);
  }
  for (const tabId of knownTabs.keys()) {
    if (await tabStillExists(tabId)) return tabId;
    knownTabs.delete(tabId);
  }
  const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
  for (const t of tabs) {
    if (typeof t.id === 'number') {
      knownTabs.set(t.id, { url: t.url ?? '', loggedIn: false });
      return t.id;
    }
  }
  return null;
}

async function tabStillExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function isTabBoundToAnySession(tabId: number): boolean {
  for (const entry of activeSessions.values()) {
    if (entry.session.chatbotTabId === tabId) return true;
  }
  return false;
}

/** Resolve when the content script announces CONNECTOR_READY on `tabId`, or
 * after `timeoutMs` (regardless — caller handles staleness later). */
function waitForConnectorReady(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Already heard from this tab?
    if (knownTabs.get(tabId)?.loggedIn) return resolve();
    let done = false;
    const listener = (msg: unknown, sender: chrome.runtime.MessageSender) => {
      if (done) return;
      if (sender.tab?.id !== tabId) return;
      const m = msg as { type?: string };
      if (m?.type === 'CONNECTOR_READY') {
        done = true;
        chrome.runtime.onMessage.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(listener);
      log(SCOPE, `waitForConnectorReady timeout on tab=${tabId}`);
      resolve();
    }, timeoutMs);
  });
}

/** Verify the DeepSeek content script is responding; if not, inject every
 * `content_scripts` entry from the manifest (isolated AND MAIN world) so a
 * tab that predates the extension load still gets the same wiring it'd
 * have with a fresh-page navigation. */
async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  if (await pingConnector(tabId)) return true;
  const entries = chrome.runtime.getManifest().content_scripts ?? [];
  if (entries.length === 0) {
    warn(SCOPE, 'no content_scripts in manifest — cannot inject');
    return false;
  }
  for (const cs of entries) {
    if (!cs.js || cs.js.length === 0) continue;
    const world = (cs as { world?: 'MAIN' | 'ISOLATED' }).world;
    log(SCOPE, `injecting into tab=${tabId}`, { files: cs.js, world: world ?? 'ISOLATED' });
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: cs.js,
        world: world === 'MAIN' ? 'MAIN' : 'ISOLATED',
      });
    } catch (e) {
      warn(SCOPE, `executeScript failed (world=${world ?? 'ISOLATED'})`, e);
    }
  }
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (await pingConnector(tabId)) return true;
  }
  warn(SCOPE, `connector did not answer PING after injection on tab=${tabId}`);
  return false;
}

async function pingConnector(tabId: number): Promise<boolean> {
  try {
    const r = (await chrome.tabs.sendMessage(tabId, { type: 'PING_CONNECTOR' })) as
      | { type?: string }
      | undefined;
    return r?.type === 'PONG_CONNECTOR';
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcastChatbotStatusForAnyTab(): void {
  // Prefer a logged-in tab if one exists. Without this preference, a freshly-
  // opened deepseek tab (loggedIn=false until its SPA hydrates) would
  // overshadow a long-lived tab where the user is signed in, leaving the
  // SidePanel showing "未就绪" indefinitely even though a usable tab is open.
  let tabId: number | null = null;
  let info: TabInfo | undefined;
  for (const [id, i] of knownTabs) {
    if (!i.loggedIn) continue;
    tabId = id;
    info = i;
    break;
  }
  if (tabId === null) {
    for (const [id, i] of knownTabs) {
      tabId = id;
      info = i;
      break;
    }
  }
  const evt: ChatbotTabStatusEvt = {
    type: 'CHATBOT_TAB_STATUS',
    chatbot: 'deepseek',
    tabId,
    ready: !!info?.loggedIn,
    loggedIn: !!info?.loggedIn,
    url: info?.url,
  };
  void chrome.runtime.sendMessage(evt).catch(() => {});
}

/** Reject all pending response promises bound to `tabId` with a
 * TabUnavailableError carrying `reason`. The orchestrator catches that
 * specific error and transitions the session into `paused`. */
function rejectPendingForTab(
  tabId: number,
  reason: 'tab_closed' | 'tab_navigated_away' | 'conv_mismatch' | 'tab_not_ready',
  detail: string,
): void {
  for (const [iter, pending] of pendingResponses) {
    if (pending.tabId !== tabId) continue;
    pendingResponses.delete(iter);
    pending.reject(new TabUnavailableError(reason, detail));
  }
}

/* ───────── driver wiring ───────── */

/** Build the shared tool executor for a session: gates `write` adapters behind
 * explicit user approval, then runs via the dispatcher. Shared by the
 * connector driver and the api engine so both modes enforce write-confirm. */
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

function makeDriver(sessionId: string, tabId: number): Driver {
  return {
    async inject({ iterationId, text }) {
      // First make sure the tab+content-script are still alive.
      if (!(await tabStillExists(tabId))) {
        throw new TabUnavailableError('tab_closed', `tab=${tabId} no longer exists`);
      }
      if (!(await ensureContentScriptInjected(tabId))) {
        throw new TabUnavailableError(
          'tab_not_ready',
          `connector on tab=${tabId} did not answer PING`,
        );
      }
      const req: InjectPromptReq = { type: 'INJECT_PROMPT', sessionId, iterationId, text };
      try {
        await chrome.tabs.sendMessage(tabId, req);
      } catch (e) {
        // Most likely cause: tab closed or navigated away between checks
        // and the sendMessage above. Treat as pauseable.
        throw new TabUnavailableError('tab_closed', `inject failed: ${msgOf(e)}`);
      }
    },
    waitForResponse({ iterationId, timeoutMs }) {
      return new Promise<ChatbotResponse>((resolve, reject) => {
        const t = setTimeout(
          () => {
            pendingResponses.delete(iterationId);
            reject(new Error(`response timeout (${timeoutMs}ms)`));
          },
          timeoutMs ?? 5 * 60 * 1000,
        );
        pendingResponses.set(iterationId, {
          tabId,
          resolve: (r) => {
            clearTimeout(t);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(t);
            reject(e);
          },
        });
      });
    },
    executeTool: makeExecuteTool(sessionId),
    emit(evt) {
      forwardOrchEvent(sessionId, evt);
    },
  };
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
      };
      sendToSidepanel(out);
      break;
    }
    case 'session_paused': {
      const s = activeSessions.get(sessionId)?.session;
      const out: SessionPausedEvt = {
        type: 'SESSION_PAUSED',
        sessionId,
        reason: evt.reason,
        conversationUrl: s?.conversationUrl ?? null,
        pendingPromptPreview: evt.pendingPromptPreview,
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
  }
}

function sendToSidepanel(m: Message): void {
  // chrome.runtime.sendMessage from SW delivers to all extension pages
  // (sidepanel, popup), but NOT back to SW itself. Side panel filters by type.
  void chrome.runtime.sendMessage(m).catch(() => {
    // No listener (e.g. sidepanel closed). Not fatal.
  });
}
