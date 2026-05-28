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
}

export interface InjectAckEvt {
  type: 'INJECT_ACK';
  iterationId: string;
  ok: boolean;
  error?: string;
}

/** Chatbot reported its server is busy. Connector handles auto-retry against
 * DeepSeek's own retry button; this event is purely informational so the
 * SidePanel can surface "retrying X/N" to the user. */
export interface ChatbotBusyEvt {
  type: 'CHATBOT_BUSY';
  sessionId: string;
  iterationId: string;
  retryCount: number;
  maxRetries: number;
  /** Milliseconds until the next click of the chatbot's retry button. */
  nextRetryInMs: number;
}

/** Connector gave up after exhausting retry budget. SW rejects the pending
 * waitForResponse so the orchestrator terminates the session with an error. */
export interface ChatbotErrorEvt {
  type: 'CHATBOT_ERROR';
  sessionId: string;
  iterationId: string;
  reason: 'busy_exhausted' | 'timeout' | 'unknown';
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

/* ───────── Aggregate ───────── */

export type Message =
  | UserMessageReq
  | AbortSessionReq
  | EnsureChatbotTabReq
  | RequestLogsReq
  | GetSessionStateReq
  | AssistantTurnEvt
  | ToolTraceEvt
  | SessionDoneEvt
  | ChatbotTabStatusEvt
  | LogsResponse
  | LogEntryEvt
  | InjectPromptReq
  | PingConnectorReq
  | ChatbotResponseEvt
  | InjectAckEvt
  | ChatbotBusyEvt
  | ChatbotErrorEvt
  | ConnectorReadyEvt
  | PongConnectorEvt;

export function isMessage(v: unknown): v is Message {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}
