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
  isDeepseekIdleUrl,
  loadSession,
  makeSession,
  parseConversationUrl,
  saveSession,
  type SessionState,
} from '../agent/session';
import { executeAdapter } from '../tools/dispatcher';
import type {
  AbortSessionReq,
  AssistantTurnEvt,
  ChatbotBusyEvt,
  ChatbotErrorEvt,
  ChatbotResponseEvt,
  ChatbotStreamingEvt,
  ChatbotTabStatusEvt,
  ConnectorReadyEvt,
  DiscardSessionReq,
  EnsureChatbotTabReq,
  InjectPromptReq,
  IterationProgressEvt,
  LogEntryEvt,
  LogsResponse,
  Message,
  RequestLogsReq,
  ResumeSessionReq,
  SessionDoneEvt,
  SessionPausedEvt,
  ToolTraceEvt,
  UserMessageReq,
} from '../connectors/messages';

// Side-effect imports: each adapter file's top-level cli({...}) registers it
// with the global registry that openAiToolsFromRegistry / lookupAdapter read.
import '../tools/xiaohongshu/_all';

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

/* ───────── lifecycle ───────── */

log(SCOPE, 'service worker booting');

chrome.runtime.onInstalled.addListener(() => {
  log(SCOPE, 'onInstalled');
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => warn(SCOPE, 'setPanelBehavior failed', e));
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));

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
    case 'LOG_ENTRY': {
      ingestEntry((m as LogEntryEvt).entry);
      return false;
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
  //    the DeepSeek conversation URL. Open it in a fresh tab — DeepSeek
  //    serves the conv history from the server side per URL, so the chatbot
  //    still has all of the prior turns in context. Drive in continuation
  //    mode so we just send the new userText (no system-prompt reinject).
  if (session.conversationUrl) {
    log(SCOPE, `session=${session.id} bound tab dead — re-opening conv URL`, {
      conversationUrl: session.conversationUrl,
    });
    const reopened = await openOrFocusTab(session.conversationUrl);
    if (reopened !== null) {
      session.chatbotTabId = reopened;
      await driveSession(session, m.text, /* resume */ false, /* continuation */ true);
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
  await driveSession(
    session,
    session.pendingPrompt ?? '',
    /* resume */ true,
    /* continuation */ false,
  );
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
  // First check our known map.
  for (const tabId of knownTabs.keys()) {
    if (await tabStillExists(tabId)) return tabId;
    knownTabs.delete(tabId);
  }
  // Fallback to global query.
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

/** Verify the DeepSeek content script is responding; if not, inject it. */
async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  if (await pingConnector(tabId)) return true;
  const cs = chrome.runtime.getManifest().content_scripts?.[0];
  if (!cs?.js || cs.js.length === 0) {
    warn(SCOPE, 'no content_scripts entry in manifest — cannot inject');
    return false;
  }
  log(SCOPE, `injecting content script into tab=${tabId}`);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: cs.js });
  } catch (e) {
    warn(SCOPE, 'chrome.scripting.executeScript failed', e);
    return false;
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
  let tabId: number | null = null;
  let info: TabInfo | undefined;
  for (const [id, i] of knownTabs) {
    tabId = id;
    info = i;
    break;
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
    executeTool: (opts) => executeAdapter(opts) as Promise<ToolExecResult>,
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
