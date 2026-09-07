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

import type { LogEntry } from '@base/runtime/log';
import type { PlanState } from './agent/plan';
import type { MemoryState } from './agent/memory-store';
import type { Note } from './agent/notes-store';
import type { Schedule } from './schedules/store';
import type { AdapterHealth } from './adapters/adapter-health-store';
import type { SiteScript, SiteScriptInput } from '@base/site-scripts/store';
// Base-owned tool-command shapes (hoisted out to sever manifest.ts's edge into
// this full message catalog — P4, §A). Imported for local use in the message
// interfaces below and re-exported so existing `from '../messages'` importers
// keep working.
import type { ExploreAdapterArg, AdapterCommand } from '@base/tools/command-types';
export type { ExploreAdapterArg, AdapterCommand };

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

/** A web page a user turn refers to (summarize this page / chat with the page). Captured at click
 * time in the panel (tabId locked THEN — the agent must not re-resolve the
 * active tab later, or a tab switch mid-run targets the wrong page). Rendered
 * as a quote card (favicon + title + url) under the user bubble. */
export interface PageRef {
  tabId?: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface UserMessageReq {
  type: 'USER_MESSAGE';
  sessionId: string;
  text: string;
  /** Compact text for the user bubble when `text` is a long generated prompt
   * (e.g. "Summarize this page"). Display + history only — the agent sees `text`. */
  displayText?: string;
  /** Pages this turn refers to — persisted on the turn and rendered as quote
   * cards under the bubble (live and in history). */
  pageRefs?: PageRef[];
  /** Inline images attached by the user (PNG data URLs, e.g. a region
   * screenshot) — sent to the (vision-capable) model as image_url content on
   * this turn. */
  images?: string[];
  /** 'plan' makes the agent research read-only, propose a plan for approval,
   * then execute. 'explore' drives the site once while recording a trace, then
   * synthesizes a deterministic adapter (docs/llm-explore.md). 'chat' (default)
   * executes directly. */
  mode?: 'chat' | 'plan' | 'explore';
  /** Auto mode (per-conversation): skip the per-write confirmation dialog for
   * this run (the in-panel twin of the bridge's "allow external writes"). Off by default. */
  autoApprove?: boolean;
  /** H1-P2 heal run: the drifted adapter this explore run re-derives. Carried to
   * the SW so the auto-persist after a passing synthesis overwrites the ORIGINAL
   * id (origin manual+healedFrom, no `my-` re-homing) instead of creating a new
   * explore-origin copy. One-turn semantics: reset on every USER_MESSAGE. */
  healTarget?: {
    id: string;
    site: string;
    name: string;
    origin: {
      type: 'marketplace' | 'manual' | 'explore';
      url?: string;
      healedFrom?: 'marketplace';
    };
  };
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

/** In-page cockpit mask heartbeat (A, page-agent-comparison §4.3.6): the
 * injected mask pings every ~2.5s; the SW answers alive while the run is still
 * driving that tab. A dead SW / ended run / reloaded extension stops answering
 * → the mask disarms itself in-page. */
export interface MaskPingReq {
  type: 'MASK_PING';
}

/** Panel asks the SW to (re-)register installed adapters that were deferred —
 * the "Allow user scripts just got enabled" recovery path (adapter-hot-plug §10.38):
 * func defs persist but only register when chrome.userScripts is available,
 * which is a per-extension toggle users must flip. */
export interface ReregisterAdaptersReq {
  type: 'REREGISTER_ADAPTERS';
}
export interface ReregisterAdaptersResp {
  ok: boolean;
  /** Whether the SW sees chrome.userScripts right now. False after enabling
   * the toggle usually means the extension needs one reload. */
  available: boolean;
  adapters: number;
  commands: number;
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
  /** Present when the session is a scheduled-task run record (H3) — the
   * history list shows a ⏰ scheduled-task badge with this label. */
  scheduleLabel?: string;
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

/** SW → SidePanel: a tool failed because it needs a human AT the browser (a
 * login wall / auth_required / captcha) — something the agent can't do itself.
 * The agent loop PAUSES; the panel asks the user to take over the focused tab
 * (the SW activates it), then RESUMES on their decision. Distinct from
 * WriteConfirm (which gates an *outbound* write); this gates an *inbound* human
 * step. H9-P1 (human takeover). */
export interface HumanTakeoverReq {
  type: 'HUMAN_TAKEOVER_REQ';
  sessionId: string;
  takeoverId: string;
  /** The tool that hit the wall (for display). */
  tool: string;
  /** The host that needs auth (from AuthRequiredError.domain), if known. */
  domain?: string;
  /** The tab the SW focused for the user to act on, if known. */
  tabId?: number;
  /** PROACTIVE takeover (③): the agent called `await_user_action` — this is what
   * it needs the user to do (login / captcha / a human-judgment step), shown
   * verbatim. Absent for the reactive (a tool hit an auth wall) case. */
  message?: string;
  /** ③b auto-resume: if set, the SW polls the tab and resolves the takeover on
   * its own when the selector appears/disappears — no manual "I'm done" click
   * needed. The card shows this as a hint (it still lets the user resolve/skip). */
  autoResume?: AwaitResumeHint;
}

/** ③b auto-resume hint: a CSS selector whose appearance (or disappearance) means
 * the human step (login / captcha) is done, so `await_user_action` resolves
 * without a manual click. Threaded agent → engine → requestHumanTakeover poll. */
export interface AwaitResumeHint {
  selector: string;
  until: 'appear' | 'disappear';
}

/** SidePanel's reply. `resume: true` = "I took over (logged in / solved it) —
 * retry the tool"; `false` (incl. give-up / timeout / panel-close) = surface the
 * original auth error to the model. */
export interface HumanTakeoverResp {
  type: 'HUMAN_TAKEOVER_RESP';
  takeoverId: string;
  resume: boolean;
}

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
   * and the promised "keep chatting (based on the history context)" started a fresh, empty session. */
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

/** SW → SidePanel: a subagent lane started/finished (parallel-execution v2).
 * The panel renders live parallel lanes with truthful per-lane status. */
export interface SubagentEvt {
  type: 'SUBAGENT_EVT';
  sessionId: string;
  phase: 'start' | 'done';
  /** Stable lane id — the spawn_subagent tool_call id. */
  id: string;
  task: string;
  ok?: boolean;
  digestChars?: number;
  durationMs?: number;
}

/** SW → SidePanel: the agent's living plan/todo changed; re-render the
 * checklist (Phase 1). */
export interface PlanUpdatedEvt {
  type: 'PLAN_UPDATED';
  sessionId: string;
  plan: PlanState;
}

/** SW → SidePanel: the run's mode changed mid-flight — today only chat→explore
 * via the agent's enter_explore_mode request (user-confirmed). The panel syncs
 * its composer mode badge so follow-up turns stay in the new mode. */
export interface ModeChangedEvt {
  type: 'MODE_CHANGED';
  sessionId: string;
  mode: 'chat' | 'plan' | 'explore';
}

/** SW → SidePanel: an explore run finished. Carries the trace summary and (if
 * synthesis succeeded) the proposed adapter source so the panel can offer a
 * one-click install through the normal sandbox-eval path. */
export interface ExploreResultEvt {
  type: 'EXPLORE_RESULT';
  sessionId: string;
  traceId: string;
  /** Whether synthesis produced an installable adapter. */
  ok: boolean;
  site?: string;
  name?: string;
  /** Synthesized adapter source (opencli `cli({...})` format), ready to install. */
  source?: string;
  /** One-line strategy / rationale from the synthesizer. */
  summary?: string;
  /** Example args (from the trace) to verify the adapter with after install. */
  testArgs?: Record<string, unknown>;
  /** Trace stream counts for the summary line. */
  counts?: { network: number; action: number; state: number };
  error?: string;
}

/* ───────── Explore v2 (agent-driven, multi-adapter) ───────── */

/** One arg of a synthesized adapter, for the editable "verify" form. */
// ExploreAdapterArg + AdapterCommand moved to ./tools/command-types (base):
// see the import + re-export near the top of this file (P4, §A).

/** Verify outcome — both the agent's automated smoke test and the
 * user's real-args run produce this. */
export interface ExploreAdapterVerify {
  ok: boolean;
  /** Row count when the result is an array. */
  rows?: number;
  /** Truncated JSON preview of the result. */
  preview?: string;
  error?: string;
}

/** Lifecycle of one synthesized adapter as it streams to the explore-results card.
 * synthesizing → (untested → verifying →) passed | failed. */
export type ExploreAdapterStatus = 'synthesizing' | 'untested' | 'verifying' | 'passed' | 'failed';

/** One row in the persistent multi-adapter explore-results card. The engine upserts
 * this (by `id`) as synthesis + smoke-test progress; the panel renders + lets
 * the user run the editable-args verify, install, repair, or download the trace. */
export interface ExploreAdapter {
  /** Stable id for this card row (one per synthesize_adapter call). */
  id: string;
  traceId: string;
  site?: string;
  name?: string;
  /** `${site}__${name}` once known. */
  tool?: string;
  status: ExploreAdapterStatus;
  /** Synthesized opencli `cli({...})` source. */
  source?: string;
  /** One-line strategy / rationale from the synthesizer. */
  summary?: string;
  /** Parsed arg schema (from sandbox eval) for the editable verify form. */
  args?: ExploreAdapterArg[];
  /** Example args from the trace — defaults/hints for the form. */
  testArgs?: Record<string, unknown>;
  /** Latest verify result (smoke test or user run). */
  verify?: ExploreAdapterVerify;
  /** Persisted into the installed store (auto on a passing verify / write-skip;
   * shows in Explore-generated). Session-callable ≠ persisted. */
  installed?: boolean;
  error?: string;
  /** Repair history (previous sources + their errors). */
  versions?: { source: string; summary?: string; ts: number; error?: string }[];
  ts: number;
}

/** SW → SidePanel: upsert one adapter row on the persistent explore-results card. */
export interface ExploreAdapterEvt {
  type: 'EXPLORE_ADAPTER';
  sessionId: string;
  adapter: ExploreAdapter;
}


/** SidePanel → SW: run a single read tool once (explore verify). The SW
 * runs it through the dispatcher and returns the raw result. Refused for write
 * adapters. */
export interface RunToolReq {
  type: 'RUN_TOOL';
  tool: string;
  args: Record<string, unknown>;
}

export interface RunToolResp {
  type: 'RUN_TOOL_RESP';
  ok: boolean;
  /** Row count when the result is an array. */
  rows?: number;
  /** Truncated JSON preview of the result. */
  preview?: string;
  error?: string;
}

/** SidePanel → SW: re-synthesize the adapter for a trace, feeding back the
 * previous source + the run error so the model can fix it (bounded repair). */
export interface ExploreRepairReq {
  type: 'EXPLORE_REPAIR';
  sessionId: string;
  traceId: string;
  prevSource: string;
  error: string;
}

/** SidePanel → SW: record an explore adapter's verify outcome so the
 * Adapters list can show untested / passed / failed. */
export interface SetAdapterVerifyReq {
  type: 'SET_ADAPTER_VERIFY';
  id: string;
  status: 'untested' | 'passed' | 'failed';
  note?: string;
}

/** SidePanel → SW: import an external trace file's text (opencli trace.jsonl /
 * network.jsonl, or our exported <traceId>.json), store it, and synthesize an
 * adapter from it — surfaced via the normal EXPLORE_RESULT card. */
export interface ImportTraceReq {
  type: 'IMPORT_TRACE';
  sessionId: string;
  /** Raw file contents. */
  text: string;
  /** Original filename (for the trace label / logging). */
  filename?: string;
}

/** SidePanel → SW: fetch a full trace (metadata + events) for export/download. */
export interface GetTraceReq {
  type: 'GET_TRACE';
  traceId: string;
}

export interface GetTraceResp {
  type: 'GET_TRACE_RESP';
  /** The full trace object (TraceMeta & { events }) or null if unknown. */
  trace: unknown;
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
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' };
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
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' };
  /** Explore-synthesized adapters only: verify outcome. */
  verifyStatus?: 'untested' | 'passed' | 'failed';
  verifyNote?: string;
  /** One-line description (first command's), shown on the installed card. */
  description?: string;
}

export interface ListInstalledResp {
  type: 'LIST_INSTALLED_RESP';
  adapters: InstalledAdapterSummary[];
}

/** SidePanel → SW: fetch one installed adapter's full source (view / download).
 * Source isn't in the list summary (it's large); pulled on demand. */
export interface GetAdapterSourceReq {
  type: 'GET_ADAPTER_SOURCE';
  id: string;
}

export interface GetAdapterSourceResp {
  type: 'GET_ADAPTER_SOURCE_RESP';
  source?: string;
  title?: string;
}

/** One runnable command within an installed adapter (for manual execution, T6a). */
// AdapterCommand moved to ./tools/command-types (base) — re-exported at top.

/** External-control bridge (T7) status + toggle. */
export interface GetBridgeStatusReq {
  type: 'GET_BRIDGE_STATUS';
}
export interface GetBridgeStatusResp {
  type: 'GET_BRIDGE_STATUS_RESP';
  enabled: boolean;
  connected: boolean;
  port: number;
  allowWrites: boolean;
  denySites: string[];
}
export interface BridgeCall {
  ts: number;
  tool: string;
  ok: boolean;
  write: boolean;
  error?: string;
  durationMs: number;
}

export interface GetBridgeLogReq {
  type: 'GET_BRIDGE_LOG';
}

export interface GetBridgeLogResp {
  type: 'GET_BRIDGE_LOG_RESP';
  calls: BridgeCall[];
}

export interface ListSchedulesReq {
  type: 'LIST_SCHEDULES';
}

export interface SaveScheduleReq {
  type: 'SAVE_SCHEDULE';
  schedule: Schedule;
}

export interface DeleteScheduleReq {
  type: 'DELETE_SCHEDULE';
  id: string;
}

export interface SchedulesResp {
  type: 'SCHEDULES_RESP';
  schedules: Schedule[];
}

export interface RunScheduleNowReq {
  type: 'RUN_SCHEDULE_NOW';
  id: string;
}

export interface RunScheduleNowResp {
  type: 'RUN_SCHEDULE_NOW_RESP';
  ok: boolean;
  error?: string;
  /** The session recording this run (open it from Session history). */
  sessionId?: string;
}

export interface SetBridgeEnabledReq {
  type: 'SET_BRIDGE_ENABLED';
  enabled: boolean;
  port?: number;
  allowWrites?: boolean;
  /** Sites where external WRITE tool-calls are always blocked (H2-P2b). */
  writeDenySites?: string[];
}

/** SidePanel → SW: append a context message to a session WITHOUT running the
 * agent. Creates the session if needed; the next user turn will have it in
 * context. (A generic primitive; currently unused after workflows became prompts.) */
export interface InjectContextReq {
  type: 'INJECT_CONTEXT';
  sessionId: string;
  text: string;
}

/** SidePanel → SW: every registered tool + arg schema (adapter + generic) — for
 * the `/` command palette's insertable-tools group. */
export interface GetAllToolsReq {
  type: 'GET_ALL_TOOLS';
}
export interface GetAllToolsResp {
  type: 'GET_ALL_TOOLS_RESP';
  commands: AdapterCommand[];
}

/** SidePanel → SW: list an installed adapter's commands + arg schemas, so the
 * user can run one by hand (the list summary omits per-command args). */
export interface GetAdapterCommandsReq {
  type: 'GET_ADAPTER_COMMANDS';
  id: string;
}

export interface GetAdapterCommandsResp {
  type: 'GET_ADAPTER_COMMANDS_RESP';
  commands: AdapterCommand[];
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

/* ───────── Long-term memory (SidePanel ↔ SW) — single markdown blob ───────── */

/** Read the current memory state (enabled + content). */
export interface GetMemoryReq {
  type: 'GET_MEMORY';
}
/** Reply for GET_MEMORY and every mutation below. */
export interface MemoryStateResp {
  type: 'MEMORY_STATE';
  state: MemoryState;
}
/** Direct user edit — replace the whole document. */
export interface SetMemoryReq {
  type: 'SET_MEMORY';
  content: string;
}
/** Flip the master switch (ChatGPT-style "Enable memory"). */
export interface SetMemoryEnabledReq {
  type: 'SET_MEMORY_ENABLED';
  enabled: boolean;
}
/** Agent-assisted "add or update": the SW runs a scoped LLM rewrite of the blob
 * from a short instruction and returns the new state (or an error). */
export interface EditMemoryLlmReq {
  type: 'EDIT_MEMORY_LLM';
  instruction: string;
}
export interface EditMemoryLlmResp {
  type: 'MEMORY_EDIT_RESP';
  state: MemoryState | null;
  error?: string;
}

/* ───────── Site scripts (persistent ad removal / enhancement) (SidePanel ↔ SW) ───────── */

export interface ListSiteScriptsReq {
  type: 'LIST_SITE_SCRIPTS';
}
export interface ListSiteScriptsResp {
  type: 'LIST_SITE_SCRIPTS_RESP';
  scripts: SiteScript[];
  /** Whether the "Allow user scripts" toggle is on (else rules don't run). */
  runnable: boolean;
}
export interface SetSiteScriptEnabledReq {
  type: 'SET_SITE_SCRIPT_ENABLED';
  id: string;
  enabled: boolean;
}
export interface DeleteSiteScriptReq {
  type: 'DELETE_SITE_SCRIPT';
  id: string;
}
/** Manual authoring / edit from the sidebar form. `id` present = update that
 * record in place; absent = create new. User-authored → no confirm. */
export interface CreateSiteScriptReq {
  type: 'CREATE_SITE_SCRIPT';
  input: SiteScriptInput;
  id?: string;
}
export interface SiteScriptMutResp {
  type: 'SITE_SCRIPT_MUT_RESP';
  script: SiteScript | null;
  error?: string;
}
/** Bulk import (from an exported JSON). Each raw entry is validated + registered
 * fresh; returns how many landed vs were rejected. */
export interface ImportSiteScriptsReq {
  type: 'IMPORT_SITE_SCRIPTS';
  scripts: unknown[];
}
export interface ImportSiteScriptsResp {
  type: 'IMPORT_SITE_SCRIPTS_RESP';
  imported: number;
  failed: number;
}

export interface ListNotesReq {
  type: 'LIST_NOTES';
}

export interface ListNotesResp {
  type: 'LIST_NOTES_RESP';
  notes: Note[];
}

export interface AddNoteReq {
  type: 'ADD_NOTE';
  title?: string;
  content: string;
  source?: Note['source'];
}

export interface UpdateNoteReq {
  type: 'UPDATE_NOTE';
  id: string;
  title?: string;
  content?: string;
}

export interface DeleteNoteReq {
  type: 'DELETE_NOTE';
  id: string;
}

export interface NoteMutResp {
  type: 'NOTE_MUT_RESP';
  note: Note | null;
}

export interface GetAdapterHealthReq {
  type: 'GET_ADAPTER_HEALTH';
}

export interface GetAdapterHealthResp {
  type: 'GET_ADAPTER_HEALTH_RESP';
  health: AdapterHealth[];
}

/** SW → SidePanel: an installed adapter just drifted into "broken" (H1-P2c) —
 * the panel surfaces a proactive heal prompt. */
export interface AdapterBrokenEvt {
  type: 'ADAPTER_BROKEN';
  id: string;
  tool: string;
  error?: string;
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' };
}

/* ───────── Selection toolbar (content script ↔ SW) ───────── */

/** Content script → SW: run ONE completion over the selected text (Translate /
 * Explain / Summarize / custom action). No agent loop, no tools — response goes back via
 * sendResponse ({ok, result?, error?}) and renders in the in-page popover. */
export interface SelectionLlmReq {
  type: 'SELECTION_LLM';
  /** Action label (popover title). */
  label: string;
  /** The action's instruction (settings-defined). */
  prompt: string;
  text: string;
  title?: string;
  url?: string;
}

/** Content script → SW: Ask — open the SidePanel (user-gesture context) and
 * park the quote in storage.session['pendingSelectionAsk'] for the panel to
 * consume into the composer. */
export interface SelectionAskReq {
  type: 'SELECTION_ASK';
  text: string;
  title?: string;
  url?: string;
}

/* ───────── Aggregate ───────── */

/** SidePanel → SW: load a marketplace adapter for the session (no install) so it
 * can be run from the Marketplace tab without installing. Returns its commands. */
export interface LoadAdapterReq {
  type: 'LOAD_ADAPTER';
  site: string;
  name: string;
}
export interface LoadAdapterResp {
  type: 'LOAD_ADAPTER_RESP';
  ok: boolean;
  commands?: AdapterCommand[];
  error?: string;
}

/** SidePanel → SW: (re-)register raw adapter source into the LIVE registry for
 * this session only (offscreen eval → registerSessionDefs, no persist). Used by
 * the explore-results card's verify when its tool vanished with a SW restart — the
 * session registration is ephemeral by design, so re-create it instead of
 * installing (the old fallback installed, which re-homed explore defs to `my-`
 * and left the un-prefixed tool still unregistered). */
export interface RegisterSessionAdapterReq {
  type: 'REGISTER_SESSION_ADAPTER';
  source: string;
}
export interface RegisterSessionAdapterResp {
  type: 'REGISTER_SESSION_ADAPTER_RESP';
  ok: boolean;
  /** Commands that became callable now (func defs need the userScripts toggle). */
  registered?: number;
  error?: string;
}

export type Message =
  | UserMessageReq
  | AbortSessionReq
  | MaskPingReq
  | ReregisterAdaptersReq
  | LoadAdapterReq
  | LoadAdapterResp
  | RegisterSessionAdapterReq
  | RegisterSessionAdapterResp
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
  | HumanTakeoverReq
  | HumanTakeoverResp
  | AssistantTurnEvt
  | AssistantTurnPatchEvt
  | RunStatsEvt
  | ToolTraceEvt
  | SessionDoneEvt
  | SessionNoticeEvt
  | SubagentEvt
  | PlanUpdatedEvt
  | ModeChangedEvt
  | IterationProgressEvt
  | ExploreResultEvt
  | ExploreAdapterEvt
  | RunToolReq
  | RunToolResp
  | ExploreRepairReq
  | SetAdapterVerifyReq
  | ImportTraceReq
  | GetTraceReq
  | GetTraceResp
  | LogsResponse
  | LogEntryEvt
  | InstallAdapterReq
  | InstallAdapterResp
  | UninstallAdapterReq
  | SetAdapterEnabledReq
  | ListInstalledReq
  | ListInstalledResp
  | GetAdapterSourceReq
  | GetAdapterSourceResp
  | GetAdapterCommandsReq
  | GetAdapterCommandsResp
  | GetAllToolsReq
  | GetAllToolsResp
  | InjectContextReq
  | GetBridgeStatusReq
  | GetBridgeStatusResp
  | SetBridgeEnabledReq
  | ListStaleAdaptersReq
  | ListStaleAdaptersResp
  | AdaptersChangedEvt
  | ListSiteScriptsReq
  | ListSiteScriptsResp
  | SetSiteScriptEnabledReq
  | DeleteSiteScriptReq
  | CreateSiteScriptReq
  | SiteScriptMutResp
  | ImportSiteScriptsReq
  | ImportSiteScriptsResp
  | GetMemoryReq
  | SetMemoryReq
  | SetMemoryEnabledReq
  | EditMemoryLlmReq
  | EditMemoryLlmResp
  | MemoryStateResp
  | ListNotesReq
  | ListNotesResp
  | AddNoteReq
  | UpdateNoteReq
  | DeleteNoteReq
  | NoteMutResp
  | GetAdapterHealthReq
  | GetAdapterHealthResp
  | AdapterBrokenEvt
  | GetBridgeLogReq
  | GetBridgeLogResp
  | ListSchedulesReq
  | SaveScheduleReq
  | DeleteScheduleReq
  | SchedulesResp
  | RunScheduleNowReq
  | RunScheduleNowResp
  | SelectionLlmReq
  | SelectionAskReq;

export function isMessage(v: unknown): v is Message {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}
