/**
 * Message protocol shared by SidePanel ↔ Service Worker ↔ Chatbot Connector.
 *
 * Wire-format is structured-clonable (no functions / DOM nodes). All inter-context
 * traffic goes through `chrome.runtime.sendMessage` or `chrome.tabs.sendMessage`.
 */

import type { LogEntry } from '../runtime/log';

export interface ParsedCommand {
  /** Raw JSON object as parsed from a ```agent-command code block. */
  action: 'list_tools' | 'describe_tool' | 'execute_tool' | 'done' | string;
  /** For execute_tool: full tool name like "xiaohongshu__feed". */
  tool?: string;
  /** Action-specific arguments. */
  args?: Record<string, unknown>;
  /** Reason / note (e.g. for `done`). */
  message?: string;
  /** Original code-block text (kept for debugging / display). */
  raw: string;
}

export interface ToolTrace {
  id: string;
  action: string;
  tool?: string;
  args?: Record<string, unknown>;
  status: 'started' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  durationMs?: number;
}

/* ───────── SidePanel → Service Worker ───────── */

export interface UserMessageReq {
  type: 'USER_MESSAGE';
  sessionId: string;
  text: string;
}

export interface AbortSessionReq {
  type: 'ABORT_SESSION';
  sessionId: string;
}

/** Acknowledge a paused session: open the bound conversation in a fresh tab
 * and re-run the orchestrator with the saved pendingPrompt (if any). */
export interface ResumeSessionReq {
  type: 'RESUME_SESSION';
  sessionId: string;
}

/** Drop a paused session for good (deletes from storage, lets user start
 * fresh). */
export interface DiscardSessionReq {
  type: 'DISCARD_SESSION';
  sessionId: string;
}

export interface EnsureChatbotTabReq {
  type: 'ENSURE_CHATBOT_TAB';
  chatbot: 'deepseek';
}

export interface RequestLogsReq {
  type: 'REQUEST_LOGS';
}

export interface GetSessionStateReq {
  type: 'GET_SESSION_STATE';
}

/** Sidepanel asks SW to enumerate persisted sessions (for the history
 * drawer). SW reads from session-store (IndexedDB). */
export interface ListSessionsReq {
  type: 'LIST_SESSIONS';
  limit?: number;
}

export interface ListSessionsResp {
  type: 'LIST_SESSIONS_RESP';
  sessions: SessionSummary[];
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'idle' | 'running' | 'paused' | 'aborted' | 'error';
  conversationId: string | null;
  conversationUrl: string | null;
  pauseReason: string | null;
  iterations: number;
  /** First user turn text (truncated). */
  preview: string;
  /** Total turn counts for the row badge. */
  turnCount: number;
  toolCallCount: number;
}

/** Sidepanel asks SW to load a single session's full state (for the
 * history detail view). */
export interface GetSessionReq {
  type: 'GET_SESSION';
  sessionId: string;
}

export interface GetSessionResp {
  type: 'GET_SESSION_RESP';
  /** Whole SessionState (or null if not in storage). */
  session: unknown;
}

/** Hard-delete a historical session from storage. Distinct from
 * DiscardSessionReq, which aborts an in-flight session and only flips
 * its status to 'aborted'. */
export interface DeleteSessionReq {
  type: 'DELETE_SESSION';
  sessionId: string;
}

/** SW asks the SidePanel for explicit user approval before running an
 * adapter declared `access: 'write'` (xiaohongshu publish / comment-create
 * today). The dispatcher blocks on the user's decision. */
export interface WriteConfirmReq {
  type: 'WRITE_CONFIRM_REQ';
  sessionId: string;
  confirmId: string;
  tool: string;
  args: Record<string, unknown>;
  description?: string;
}

/** SidePanel's reply. `approved: false` (including timeout / panel-close)
 * causes the dispatcher to short-circuit with a structured tool error so
 * the chatbot sees the decline. */
export interface WriteConfirmResp {
  type: 'WRITE_CONFIRM_RESP';
  confirmId: string;
  approved: boolean;
}

/* ───────── Service Worker → SidePanel ───────── */

export interface AssistantTurnEvt {
  type: 'ASSISTANT_TURN';
  sessionId: string;
  cleanedText: string;
  /** Markdown-like text reconstructed from the DOM, BEFORE command extraction.
   * Lets the SidePanel show the exact bytes we parsed (useful when
   * `commands.length === 0` but the user expected one — easier than checking
   * console logs). */
  rawText?: string;
  reasoningText?: string;
  commands: ParsedCommand[];
  iteration: number;
}

export interface ToolTraceEvt {
  type: 'TOOL_TRACE';
  sessionId: string;
  trace: ToolTrace;
}

export interface SessionDoneEvt {
  type: 'SESSION_DONE';
  sessionId: string;
  reason: 'no_more_commands' | 'done_signal' | 'max_iterations' | 'error' | 'user_abort';
  error?: string;
}

/** Iteration entered a specific phase — used by the SidePanel to drive the
 * grey progress banner ("DeepSeek tab #N 思考中…" / "正在生成…" etc.). */
export interface IterationProgressEvt {
  type: 'ITERATION_PROGRESS';
  sessionId: string;
  iterationId: string;
  iteration: number;
  phase:
    | 'starting' // orchestrator about to inject
    | 'injecting' // INJECT_PROMPT just sent
    | 'awaiting' // chatbot is generating
    | 'streaming' // partial textLen available
    | 'completed'; // response received & parsed
  /** Only set for `streaming`: current visible char count of the assistant
   * message (so the SidePanel can show "正在生成 (~XXX 字)…"). */
  textLen?: number;
}

/** Session is paused because its bound chatbot tab disappeared (closed,
 * navigated away, or the user switched the tab to a different DeepSeek
 * conversation). The SidePanel disables the input and surfaces a red
 * banner with Resume / Discard buttons. */
export interface SessionPausedEvt {
  type: 'SESSION_PAUSED';
  sessionId: string;
  reason: 'tab_closed' | 'tab_navigated_away' | 'conv_mismatch' | 'tab_not_ready';
  /** Saved deepseek conversation URL — Resume opens a new tab here. */
  conversationUrl: string | null;
  /** The prompt that was about to be injected when pause happened, if any. */
  pendingPromptPreview?: string;
}

/** Free-form inline notice the SW pushes into the chat flow when something
 * the user should know about happens, but it's not a fatal error. Today
 * the main consumer is the conv-lost auto-recovery in handleUserMessage /
 * handleResume — we want the user to see "your DeepSeek conv was deleted,
 * we're starting fresh" instead of silently doing it. */
export interface SessionNoticeEvt {
  type: 'SESSION_NOTICE';
  sessionId: string;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface ChatbotTabStatusEvt {
  type: 'CHATBOT_TAB_STATUS';
  chatbot: 'deepseek';
  tabId: number | null;
  ready: boolean;
  loggedIn?: boolean;
  url?: string;
  reason?: string;
}

export interface LogsResponse {
  type: 'LOGS_RESPONSE';
  entries: LogEntry[];
}

export interface LogEntryEvt {
  type: 'LOG_ENTRY';
  entry: LogEntry;
}

/* ───────── Service Worker → Chatbot Connector (per-tab) ───────── */

export interface InjectPromptReq {
  type: 'INJECT_PROMPT';
  sessionId: string;
  iterationId: string;
  /** The full text to send to the chatbot. */
  text: string;
}

export interface PingConnectorReq {
  type: 'PING_CONNECTOR';
}

/* ───────── Chatbot Connector → Service Worker ───────── */

export interface ChatbotResponseEvt {
  type: 'CHATBOT_RESPONSE';
  sessionId: string;
  iterationId: string;
  rawText: string;
  cleanedText: string;
  commands: ParsedCommand[];
  reasoningText?: string;
  /** location.href when the response was finalised. Lets SW capture the
   * deepseek conversation UUID — first message redirects to
   * `/a/chat/s/<uuid>`, subsequent ones keep it. */
  currentUrl?: string;
}

/** Connector emits this periodically while it's waiting for a response so
 * the SidePanel can show "正在生成 (~XXX 字)…". */
export interface ChatbotStreamingEvt {
  type: 'CHATBOT_STREAMING';
  sessionId: string;
  iterationId: string;
  textLen: number;
}

export interface InjectAckEvt {
  type: 'INJECT_ACK';
  iterationId: string;
  ok: boolean;
  error?: string;
}

/** Chatbot needed to be retried mid-response. Connector handles the click
 * against DeepSeek's own retry/regenerate button; this event is purely
 * informational so the SidePanel can surface "retrying X/N" to the user.
 *
 * `reason='busy'` — DeepSeek showed "Server is busy. Try again later" right
 *   under the user message. Connector clicks the inline retry button.
 * `reason='stopped'` — DeepSeek's thinking section finished with "Stopped"
 *   instead of producing a response (model gave up / was cancelled mid-
 *   generation). Connector clicks the per-message Regenerate button. */
export interface ChatbotBusyEvt {
  type: 'CHATBOT_BUSY';
  sessionId: string;
  iterationId: string;
  retryCount: number;
  maxRetries: number;
  /** Milliseconds until the next click of the chatbot's retry button. */
  nextRetryInMs: number;
  reason?: 'busy' | 'stopped';
}

/** Connector gave up after exhausting retry budget. SW rejects the pending
 * waitForResponse so the orchestrator terminates the session with an error. */
export interface ChatbotErrorEvt {
  type: 'CHATBOT_ERROR';
  sessionId: string;
  iterationId: string;
  reason: 'busy_exhausted' | 'stopped_exhausted' | 'timeout' | 'unknown';
  message?: string;
}

export interface ConnectorReadyEvt {
  type: 'CONNECTOR_READY';
  chatbot: 'deepseek';
  loggedIn: boolean;
  url: string;
}

export interface PongConnectorEvt {
  type: 'PONG_CONNECTOR';
}

/* ───────── Adapter install / marketplace (SidePanel ↔ SW) ─────────
 *
 * Runtime adapter hot-plug. The SidePanel hosts the sandboxed iframe that
 * evals untrusted adapter source (the SW can't eval under MV3 CSP), so the
 * flow is: SidePanel evals → sends captured defs to SW → SW persists +
 * registers. List/uninstall/enable are pure SW operations.
 */

/** A captured, serializable adapter definition (mirror of sandbox
 * CapturedAdapter / installed-store CapturedDef; redeclared here so the
 * message module stays dependency-free). */
export interface InstalledAdapterDef {
  site: string;
  name: string;
  access?: 'read' | 'write';
  description?: string;
  domain?: string;
  strategy?: string;
  args?: unknown[];
  columns?: string[];
  pipeline?: unknown[];
  navigateBefore?: unknown;
  siteSession?: string;
  kind: 'pipeline' | 'func' | 'unknown';
  hasFunc: boolean;
}

/** SidePanel → SW: persist + register an adapter the sandbox already eval'd. */
export interface InstallAdapterReq {
  type: 'INSTALL_ADAPTER';
  source: string;
  defs: InstalledAdapterDef[];
  origin: { type: 'marketplace' | 'manual'; url?: string };
}

export interface InstallAdapterResp {
  type: 'INSTALL_ADAPTER_RESP';
  ok: boolean;
  id?: string;
  title?: string;
  /** Number of captured defs successfully registered into the live tool
   * registry (= runnable now). */
  registered?: number;
  /** Captured defs that classified as `func` — persisted but Phase B (no
   * runner). */
  deferredFunc?: number;
  /** Captured defs that classified as `pipeline` but use a step type the
   * engine doesn't support (e.g. `wait`/`click`/`fill`). Persisted but not
   * runnable. */
  deferredUnsupported?: number;
  error?: string;
}

export interface UninstallAdapterReq {
  type: 'UNINSTALL_ADAPTER';
  id: string;
}

export interface SetAdapterEnabledReq {
  type: 'SET_ADAPTER_ENABLED';
  id: string;
  enabled: boolean;
}

export interface ListInstalledReq {
  type: 'LIST_INSTALLED';
}

export interface InstalledAdapterSummary {
  id: string;
  title: string;
  kind: 'pipeline' | 'func' | 'mixed' | 'unknown';
  enabled: boolean;
  commandCount: number;
  installedAt: number;
  origin: { type: 'marketplace' | 'manual'; url?: string };
}

export interface ListInstalledResp {
  type: 'LIST_INSTALLED_RESP';
  adapters: InstalledAdapterSummary[];
}

/** SW → SidePanel: installed-set changed; refresh lists + tool whitelist. */
export interface AdaptersChangedEvt {
  type: 'ADAPTERS_CHANGED';
}

/* ───────── Aggregate ───────── */

export type Message =
  | UserMessageReq
  | AbortSessionReq
  | ResumeSessionReq
  | DiscardSessionReq
  | EnsureChatbotTabReq
  | RequestLogsReq
  | GetSessionStateReq
  | ListSessionsReq
  | ListSessionsResp
  | GetSessionReq
  | GetSessionResp
  | DeleteSessionReq
  | WriteConfirmReq
  | WriteConfirmResp
  | AssistantTurnEvt
  | ToolTraceEvt
  | SessionDoneEvt
  | SessionPausedEvt
  | SessionNoticeEvt
  | IterationProgressEvt
  | ChatbotTabStatusEvt
  | LogsResponse
  | LogEntryEvt
  | InjectPromptReq
  | PingConnectorReq
  | ChatbotResponseEvt
  | ChatbotStreamingEvt
  | InjectAckEvt
  | ChatbotBusyEvt
  | ChatbotErrorEvt
  | ConnectorReadyEvt
  | PongConnectorEvt
  | InstallAdapterReq
  | InstallAdapterResp
  | UninstallAdapterReq
  | SetAdapterEnabledReq
  | ListInstalledReq
  | ListInstalledResp
  | AdaptersChangedEvt;

export function isMessage(v: unknown): v is Message {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}
