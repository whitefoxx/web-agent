/**
 * Cross-context message protocol — SidePanel ↔ Service Worker.
 *
 * Wire-format is structured-clonable (no functions / DOM nodes). All traffic
 * goes through `chrome.runtime.sendMessage`.
 *
 * Pre-history: this file used to live under `src/connectors/messages.ts` and
 * declared messages for the chatbot-tab connector too (CHATBOT_RESPONSE,
 * INJECT_PROMPT, etc.). Those have been removed along with the connector
 * mode; what's left is the union of message types used by the API engine,
 * the adapter install/marketplace flow, and the SidePanel session UI.
 */

import type { LogEntry } from './runtime/log';
import type { PlanState } from './agent/plan';
import type { MemoryFact } from './agent/memory-store';

export interface ParsedCommand {
  /** Raw JSON object parsed from an `<agent-command>` code block. Pre-history:
   * the connector mode parsed these from chatbot prose. Today the API engine
   * uses native tool_calls and emits assistant_turns with `commands: []`, but
   * the type stays in the shared shape so the SidePanel can render whatever
   * a future engine surfaces. */
  action: 'list_tools' | 'describe_tool' | 'execute_tool' | 'done' | string;
  /** For execute_tool: full tool name like "xiaohongshu__feed". */
  tool?: string;
  args?: Record<string, unknown>;
  message?: string;
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
  /** 'plan' makes the agent research read-only, propose a plan for approval,
   * then execute. 'chat' (default) executes directly. */
  mode?: 'chat' | 'plan';
}

export interface AbortSessionReq {
  type: 'ABORT_SESSION';
  sessionId: string;
}

/** SidePanel → SW: inject a message into a RUNNING session so the agent folds
 * it into its next turn (steering / course-correction) without restarting. */
export interface SteerMessageReq {
  type: 'STEER_MESSAGE';
  sessionId: string;
  text: string;
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
  status: 'idle' | 'running' | 'aborted' | 'error';
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

/** Hard-delete a historical session from storage. */
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
 * the LLM sees the decline. */
export interface WriteConfirmResp {
  type: 'WRITE_CONFIRM_RESP';
  confirmId: string;
  approved: boolean;
}

/** SW → SidePanel: ask the user to approve a proposed plan before the agent
 * leaves the read-only planning phase and starts executing (plan mode). */
export interface PlanDecisionReq {
  type: 'PLAN_DECISION_REQ';
  sessionId: string;
  decisionId: string;
  plan: PlanState;
}

/** SidePanel's reply. `reject` (incl. cancel / timeout) keeps the agent in
 * planning if feedback is given, else ends the turn. `editedSteps` lets the
 * user tweak the step list before approving. */
export interface PlanDecisionResp {
  type: 'PLAN_DECISION_RESP';
  decisionId: string;
  decision: 'approve' | 'reject';
  editedSteps?: string[];
  feedback?: string;
}

export type PlanDecision = Pick<PlanDecisionResp, 'decision' | 'editedSteps' | 'feedback'>;

/* ───────── Service Worker → SidePanel ───────── */

export interface AssistantTurnEvt {
  type: 'ASSISTANT_TURN';
  sessionId: string;
  cleanedText: string;
  /** Markdown-like text from the model BEFORE any post-processing. Kept so
   * the SidePanel can show the exact bytes we parsed — useful when
   * `commands.length === 0` but the user expected one. */
  rawText?: string;
  reasoningText?: string;
  commands: ParsedCommand[];
  iteration: number;
}

/** SW → SidePanel: incremental assistant text while streaming (full text so
 * far, not a delta). The final ASSISTANT_TURN replaces it. */
export interface AssistantTurnPatchEvt {
  type: 'ASSISTANT_TURN_PATCH';
  sessionId: string;
  iteration: number;
  text: string;
}

/** SW → SidePanel: live run meter (step count + token usage) for the cost
 * indicator. */
export interface RunStatsEvt {
  type: 'RUN_STATS';
  sessionId: string;
  step: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ToolTraceEvt {
  type: 'TOOL_TRACE';
  sessionId: string;
  trace: ToolTrace;
}

export interface SessionDoneEvt {
  type: 'SESSION_DONE';
  sessionId: string;
  reason:
    | 'no_more_commands'
    | 'done_signal'
    | 'max_iterations'
    | 'checkpoint'
    | 'error'
    | 'user_abort';
  error?: string;
  /** True when the session ended only because the SW was recycled, NOT a real
   * failure. The history is persisted in IDB, so the SidePanel must KEEP the
   * sessionId binding — sending another message resumes the same thread with
   * full context. Without this the panel dropped the binding on every `error`
   * and the promised "接着聊（基于历史上下文）" started a fresh, empty session. */
  recoverable?: boolean;
}

/** Iteration entered a specific phase — drives the grey progress banner. */
export interface IterationProgressEvt {
  type: 'ITERATION_PROGRESS';
  sessionId: string;
  iterationId: string;
  iteration: number;
  phase: 'starting' | 'injecting' | 'awaiting' | 'streaming' | 'completed';
  /** Only set for `streaming`: current visible char count of the assistant
   * message. */
  textLen?: number;
}

/** Free-form inline notice the SW pushes into the chat flow when something
 * the user should know about happens but it's not a fatal error. */
export interface SessionNoticeEvt {
  type: 'SESSION_NOTICE';
  sessionId: string;
  level: 'info' | 'warning' | 'error';
  text: string;
}

/** SW → SidePanel: the agent's living plan/todo changed; re-render the
 * checklist (Phase 1). */
export interface PlanUpdatedEvt {
  type: 'PLAN_UPDATED';
  sessionId: string;
  plan: PlanState;
}

export interface LogsResponse {
  type: 'LOGS_RESPONSE';
  entries: LogEntry[];
}

export interface LogEntryEvt {
  type: 'LOG_ENTRY';
  entry: LogEntry;
}

/* ───────── Adapter install / marketplace (SidePanel ↔ SW) ─────────
 *
 * Runtime adapter hot-plug. The SidePanel hosts the sandboxed iframe that
 * evals untrusted adapter source (the SW can't eval under MV3 CSP), so the
 * flow is: SidePanel evals → sends captured defs to SW → SW persists +
 * registers. List/uninstall/enable are pure SW operations.
 */

/** A captured, serializable adapter definition. */
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
  registered?: number;
  deferredFunc?: number;
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

/** SidePanel → SW: which installed marketplace adapters have drifted from the
 * bundled catalog (their stored source's sha256 no longer matches index.json)?
 * The SidePanel re-installs the returned ids from the catalog. */
export interface ListStaleAdaptersReq {
  type: 'LIST_STALE_ADAPTERS';
}

export interface StaleAdapterInfo {
  id: string;
  title: string;
}

export interface ListStaleAdaptersResp {
  type: 'LIST_STALE_ADAPTERS_RESP';
  stale: StaleAdapterInfo[];
}

/* ───────── Long-term memory (SidePanel ↔ SW) ───────── */

export interface ListMemoriesReq {
  type: 'LIST_MEMORIES';
}

export interface ListMemoriesResp {
  type: 'LIST_MEMORIES_RESP';
  memories: MemoryFact[];
}

export interface DeleteMemoryReq {
  type: 'DELETE_MEMORY';
  id: string;
}

/* ───────── Aggregate ───────── */

export type Message =
  | UserMessageReq
  | AbortSessionReq
  | SteerMessageReq
  | RequestLogsReq
  | GetSessionStateReq
  | ListSessionsReq
  | ListSessionsResp
  | GetSessionReq
  | GetSessionResp
  | DeleteSessionReq
  | WriteConfirmReq
  | WriteConfirmResp
  | PlanDecisionReq
  | PlanDecisionResp
  | AssistantTurnEvt
  | AssistantTurnPatchEvt
  | RunStatsEvt
  | ToolTraceEvt
  | SessionDoneEvt
  | SessionNoticeEvt
  | PlanUpdatedEvt
  | IterationProgressEvt
  | LogsResponse
  | LogEntryEvt
  | InstallAdapterReq
  | InstallAdapterResp
  | UninstallAdapterReq
  | SetAdapterEnabledReq
  | ListInstalledReq
  | ListInstalledResp
  | ListStaleAdaptersReq
  | ListStaleAdaptersResp
  | AdaptersChangedEvt
  | ListMemoriesReq
  | ListMemoriesResp
  | DeleteMemoryReq;

export function isMessage(v: unknown): v is Message {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}
