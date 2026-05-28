/**
 * Service worker — central message router + agent orchestrator host.
 *
 * Responsibilities:
 *   - Import all xiaohongshu adapters (their top-level cli({...}) registers them).
 *   - Open side panel on toolbar action click.
 *   - Route messages between SidePanel ↔ DeepSeek connector ↔ Tool dispatcher.
 *   - Run the agent orchestrator for each user message.
 *   - Aggregate logs forwarded from other contexts.
 *
 * The SW may be terminated by Chrome when idle. State that must survive
 * termination lives in chrome.storage.session (see agent/session.ts).
 * In-flight orchestrator runs do NOT survive — the sidepanel surfaces a
 * "session interrupted" error if that happens.
 */

import { log, warn, error as logError, ingestEntry } from '../runtime/log';
import {
  runSession,
  type Driver,
  type OrchEvent,
  type ChatbotResponse,
  type ToolExecResult,
} from '../agent/orchestrator';
import { makeSession, loadSession, saveSession, type SessionState } from '../agent/session';
import { executeAdapter } from '../tools/dispatcher';
import { getLocalBuffer } from '../runtime/log';
import type {
  AssistantTurnEvt,
  ChatbotBusyEvt,
  ChatbotErrorEvt,
  ChatbotResponseEvt,
  ChatbotTabStatusEvt,
  ConnectorReadyEvt,
  InjectPromptReq,
  LogEntryEvt,
  LogsResponse,
  Message,
  SessionDoneEvt,
  ToolTraceEvt,
  UserMessageReq,
  AbortSessionReq,
  EnsureChatbotTabReq,
  RequestLogsReq,
} from '../connectors/messages';

// Side-effect imports: each adapter file's top-level cli({...}) registers it
// with the global registry that openAiToolsFromRegistry / lookupAdapter read.
import '../tools/xiaohongshu/_all';

const SCOPE = 'sw';

/* ───────── runtime state (lost on SW termination) ───────── */

const activeSessions = new Map<string, { session: SessionState; abort: AbortController }>();
const pendingResponses = new Map<
  string,
  { resolve: (r: ChatbotResponse) => void; reject: (e: Error) => void }
>();

let deepseekTabId: number | null = null;
let deepseekReady = false;

/* ───────── lifecycle ───────── */

log(SCOPE, 'service worker booting');

chrome.runtime.onInstalled.addListener(() => {
  log(SCOPE, 'onInstalled');
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => warn(SCOPE, 'setPanelBehavior failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  log(SCOPE, 'onStartup');
});

chrome.action.onClicked.addListener((tab) => {
  log(SCOPE, 'action clicked', { tabId: tab.id });
  if (tab.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id }).catch((e) => warn(SCOPE, 'sidePanel.open', e));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === deepseekTabId) {
    log(SCOPE, 'deepseek tab removed');
    deepseekTabId = null;
    deepseekReady = false;
    broadcastChatbotStatus();
  }
});

/* ───────── message router ───────── */

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse): boolean | undefined => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Message;
  switch (m.type) {
    case 'USER_MESSAGE': {
      void handleUserMessage(m as UserMessageReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true;
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
      // Forward to SidePanel as a transient status; no orchestrator side-
      // effect — the connector handles auto-retry internally.
      sendToSidepanel(m as ChatbotBusyEvt);
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
    throw new Error(`session ${m.sessionId} is already running`);
  }
  const tabId = await ensureDeepseekTab();
  if (tabId === null) {
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: m.sessionId,
      reason: 'error',
      error: 'No DeepSeek tab available. Open https://chat.deepseek.com first.',
    } satisfies SessionDoneEvt);
    return;
  }

  let session = await loadSession(m.sessionId);
  if (!session) session = makeSession(m.sessionId);
  session.chatbotTabId = tabId;

  const abortCtl = new AbortController();
  activeSessions.set(m.sessionId, { session, abort: abortCtl });

  const driver = makeDriver(m.sessionId, tabId);
  try {
    await runSession({ session, userText: m.text, driver, signal: abortCtl.signal });
  } catch (e) {
    logError(SCOPE, 'runSession threw', e);
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: m.sessionId,
      reason: 'error',
      error: String(e instanceof Error ? e.message : e),
    } satisfies SessionDoneEvt);
  } finally {
    activeSessions.delete(m.sessionId);
    await saveSession(session);
  }
}

function handleAbort(m: AbortSessionReq): void {
  const entry = activeSessions.get(m.sessionId);
  if (!entry) return;
  log(SCOPE, `aborting session ${m.sessionId}`);
  entry.abort.abort();
  // Also reject any pending response so the orchestrator unblocks.
  for (const [iter, p] of pendingResponses) {
    if (iter.startsWith(m.sessionId)) {
      pendingResponses.delete(iter);
      p.reject(new Error('aborted'));
    }
  }
}

async function handleEnsureTab(_m: EnsureChatbotTabReq): Promise<ChatbotTabStatusEvt> {
  const tabId = await ensureDeepseekTab();
  return {
    type: 'CHATBOT_TAB_STATUS',
    chatbot: 'deepseek',
    tabId,
    ready: deepseekReady,
    loggedIn: deepseekReady,
  };
}

function handleRequestLogs(_m: RequestLogsReq): LogsResponse {
  return { type: 'LOGS_RESPONSE', entries: getLocalBuffer() };
}

function handleConnectorReady(m: ConnectorReadyEvt, sender: chrome.runtime.MessageSender): void {
  if (!sender.tab?.id) return;
  log(SCOPE, 'CONNECTOR_READY', { tabId: sender.tab.id, loggedIn: m.loggedIn });
  deepseekTabId = sender.tab.id;
  deepseekReady = m.loggedIn;
  broadcastChatbotStatus();
}

function handleChatbotResponse(m: ChatbotResponseEvt): void {
  const pending = pendingResponses.get(m.iterationId);
  if (!pending) {
    warn(SCOPE, `unmatched CHATBOT_RESPONSE iteration=${m.iterationId}`);
    return;
  }
  pendingResponses.delete(m.iterationId);
  pending.resolve({
    rawText: m.rawText,
    cleanedText: m.cleanedText,
    reasoningText: m.reasoningText,
    commands: m.commands,
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
      ? `DeepSeek server busy after ${BUSY_LABEL} retries — ${m.message ?? ''}`.trim()
      : m.reason === 'timeout'
        ? `DeepSeek response timeout — ${m.message ?? ''}`.trim()
        : `Chatbot error — ${m.message ?? '(unknown)'}`;
  pending.reject(new Error(msg));
}

const BUSY_LABEL = 'all';

/* ───────── deepseek tab management ───────── */

async function ensureDeepseekTab(): Promise<number | null> {
  let tabId: number | null = null;
  if (deepseekTabId !== null) {
    try {
      const tab = await chrome.tabs.get(deepseekTabId);
      if (tab.url?.startsWith('https://chat.deepseek.com')) tabId = deepseekTabId;
      else deepseekTabId = null;
    } catch {
      deepseekTabId = null;
    }
  }
  if (tabId === null) {
    const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
    if (tabs.length > 0 && typeof tabs[0].id === 'number') {
      tabId = tabs[0].id;
      deepseekTabId = tabId;
      log(SCOPE, `found existing deepseek tab=${tabId}`);
    }
  }
  if (tabId === null) {
    log(SCOPE, 'no deepseek tab open; user must open one');
    return null;
  }
  // Make sure the content script is alive. If the tab existed BEFORE the
  // extension loaded (or got reloaded), the manifest's `content_scripts`
  // entry won't re-inject — we have to push it in via chrome.scripting.
  await ensureContentScriptInjected(tabId);
  return tabId;
}

/** Verify the DeepSeek content script is responding; if not, inject it. */
async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  if (await pingConnector(tabId)) {
    log(SCOPE, `connector alive on tab=${tabId}`);
    return true;
  }
  const cs = chrome.runtime.getManifest().content_scripts?.[0];
  if (!cs?.js || cs.js.length === 0) {
    warn(SCOPE, 'no content_scripts entry in manifest — cannot inject');
    return false;
  }
  log(SCOPE, `injecting content script into tab=${tabId}`, { files: cs.js });
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: cs.js,
    });
  } catch (e) {
    warn(SCOPE, 'chrome.scripting.executeScript failed', e);
    return false;
  }
  // Wait up to ~2s for the content script's onMessage listener to register.
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (await pingConnector(tabId)) {
      log(SCOPE, `connector now responding on tab=${tabId}`);
      return true;
    }
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

function broadcastChatbotStatus(): void {
  const evt: ChatbotTabStatusEvt = {
    type: 'CHATBOT_TAB_STATUS',
    chatbot: 'deepseek',
    tabId: deepseekTabId,
    ready: deepseekReady,
    loggedIn: deepseekReady,
  };
  void chrome.runtime.sendMessage(evt).catch(() => {});
}

/* ───────── driver wiring ───────── */

function makeDriver(sessionId: string, tabId: number): Driver {
  return {
    async inject({ iterationId, text }) {
      const req: InjectPromptReq = {
        type: 'INJECT_PROMPT',
        sessionId,
        iterationId,
        text,
      };
      try {
        await chrome.tabs.sendMessage(tabId, req);
      } catch (e) {
        throw new Error(`inject failed: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        });
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
    // No listener (e.g. sidepanel closed). Not fatal — sidepanel can pull
    // recent log + session state on reopen.
  });
}
