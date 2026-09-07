/**
 * AgentEngine — the seam between the service worker (composition root) and the
 * way of driving a session.
 *
 * Today there's one engine: `api-engine.ts` (OpenAI-compatible /chat/completions
 * with native function-calling). The contract here is what would let a future
 * second engine (e.g. a Node-sidecar backend running real opencli with full
 * plugin hot-plug) slot in without the SidePanel or the tool layer caring
 * which one ran. Both would emit the shared `OrchEvent` stream and execute
 * tools through `executeTool`.
 *
 * Historical: a connector engine (chatbot-tab hijack) lived in
 * `orchestrator.ts` alongside this one until the "zero API key" mode was
 * removed. The shared types it used to declare (OrchEvent / SessionDoneReason
 * / etc.) now live here.
 */

import type {
  PageRef,
  ParsedCommand,
  ToolTrace,
  PlanDecision,
  ExploreAdapter,
  AwaitResumeHint,
} from '../messages';
import type { SessionState } from './session';
import type { PlanState } from './plan';

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Structured outcome (mirrors dispatcher's richer `ToolExecResult`, which the
   * SW casts to this type). `errorKind` drives retry / health / human-takeover
   * decisions; `tabId` + `authDomain` feed the H9 takeover prompt when a tool
   * hits a login/auth wall. All optional — most call sites only read ok/result. */
  errorKind?: 'rate_limited' | 'auth_required' | 'empty' | 'tool_not_found' | 'tab' | 'generic';
  tabId?: number;
  authDomain?: string;
  durationMs: number;
}

export type SessionDoneReason =
  | 'no_more_commands'
  | 'done_signal'
  | 'max_iterations'
  // Graceful pause: hit the step/token budget but made progress. Resumable —
  // the session binding is kept and the next user message continues with full
  // context. NOT an error. See docs/agent-harness.md §10.2.
  | 'checkpoint'
  | 'error'
  | 'user_abort';

export type IterationPhase = 'starting' | 'injecting' | 'awaiting' | 'streaming' | 'completed';

export type OrchEvent =
  | {
      type: 'assistant_turn';
      iteration: number;
      cleanedText: string;
      rawText?: string;
      reasoningText?: string;
      commands: ParsedCommand[];
    }
  // Incremental assistant text while streaming (full text so far, not a delta).
  // The SW forwards it as ASSISTANT_TURN_PATCH so the SidePanel can render the
  // bubble live; the final 'assistant_turn' finalizes it.
  | { type: 'assistant_delta'; iteration: number; text: string }
  // Live run meter: step count + token usage so far (SW → RUN_STATS).
  | { type: 'run_stats'; step: number; promptTokens: number; completionTokens: number }
  | { type: 'tool_trace'; trace: ToolTrace }
  | {
      type: 'iteration_progress';
      iteration: number;
      iterationId: string;
      phase: IterationPhase;
      /** Visible chars so far — only set while phase==='streaming'. */
      textLen?: number;
    }
  | {
      type: 'session_done';
      reason: SessionDoneReason;
      error?: string;
    }
  // Inline, non-fatal status the loop wants the user to see (e.g. a checkpoint
  // or anti-thrash break). The SW forwards it as a SESSION_NOTICE.
  | {
      type: 'notice';
      level: 'info' | 'warning' | 'error';
      text: string;
    }
  // The living plan/todo changed; the SW forwards it as PLAN_UPDATED so the
  // SidePanel re-renders its checklist.
  | {
      type: 'plan_updated';
      plan: PlanState;
    }
  // Explore v2: a synthesized adapter row was created/updated (synthesizing →
  // untested → passed/failed). The SW forwards it as EXPLORE_ADAPTER so the
  // SidePanel upserts it on the persistent Explore-results card.
  | {
      type: 'explore_adapter';
      adapter: ExploreAdapter;
    }
  // Parallel-execution v2: a subagent lane started / finished. The SW forwards
  // it as SUBAGENT_EVT so the SidePanel renders live parallel lanes.
  | {
      type: 'subagent';
      phase: 'start' | 'done';
      /** Stable lane id — the spawn_subagent tool_call id. */
      id: string;
      task: string;
      ok?: boolean;
      digestChars?: number;
      durationMs?: number;
    };

export interface EngineContext {
  session: SessionState;
  /** The user's message that starts this run. */
  userText: string;
  /** Inline images attached to the starting user message (PNG data URLs) —
   * sent to the model as image_url content on the first turn. */
  userImages?: string[];
  /** Presentation metadata for the starting user turn (compact bubble text +
   * page quote cards). Persisted on the UserTurn; never sent to the model. */
  userDisplay?: { displayText?: string; pageRefs?: PageRef[] };
  signal: AbortSignal;
  /** Follow-up turn inside an existing session. */
  continuation?: boolean;
  /** Plan mode for this run; 'plan' = research read-only → propose → approve →
   * execute. 'explore' = drive the site once recording a trace, then synthesize
   * a deterministic adapter (docs/llm-explore.md). Defaults to 'chat'. MUTABLE:
   * enterExploreMode upgrades a chat run to 'explore' mid-flight — the engine
   * re-reads it every iteration (tool list / prompt notes). */
  mode?: 'chat' | 'plan' | 'explore';
  /** One-line note about the runtime environment (e.g. installed func adapters
   * disabled because "Allow user scripts" is off) injected into the system
   * prompt so the model knows what's unavailable instead of silently faking it
   * with generic tools. */
  environmentNote?: string;
  /** Emit a UI event. */
  emit(evt: OrchEvent): void;
  /** Run a tool by `site__name`. Shared dispatcher: per-site tab management,
   * pacing, and write-confirm gating live behind this. */
  executeTool(opts: { tool: string; args: Record<string, unknown> }): Promise<ToolExecResult>;
  /** Ask the user to approve a proposed plan (plan mode). Resolves with their
   * decision; rejects (decision:'reject') on timeout / panel close. */
  requestPlanDecision(plan: PlanState): Promise<PlanDecision>;
  /** Ask the user to confirm a sensitive intercepted write (reuses the H-write
   * confirm card). Used e.g. before registering a site script that injects raw
   * CSS/JS (site-scripts v2). Resolves true = approved. Absent in tests. */
  confirmWrite?(opts: {
    tool: string;
    args: Record<string, unknown>;
    description?: string;
  }): Promise<boolean>;
  /** Proactively pause the run and ask the user to complete a step in the browser
   * they alone can do (login / captcha / a human-judgment step), then resume.
   * Resolves true if they completed it, false on skip / timeout. Reuses the H9
   * human-takeover UI (③ await_user_action). `resume`, if given, auto-resolves
   * when a selector appears/disappears (③b) — no manual "I'm done" click. */
  awaitUserAction(objective: string, tabId?: number, resume?: AwaitResumeHint): Promise<boolean>;
  /** Drain any messages the user injected mid-run (steering); [] if none. */
  takeSteerMessages(): string[];
  /** Explore mode: synthesize a deterministic adapter from the trace slice the
   * agent just produced, surface it on the Explore-results card (streaming status),
   * session-register + smoke-test it, and return a concise result string for
   * the agent (so it can repair-and-retry or move on). Absent outside explore
   * mode / in tests. See docs/llm-explore.md § Explore v2. */
  synthesizeExploreAdapter?(opts: { name?: string; notes?: string }): Promise<string>;
  /** Explore mode: record one reusable site finding (persisted to site memory,
   * surfaced on later explores). Fire-and-forget. Absent outside explore. */
  noteFinding?(f: { text: string; kind?: string }): void;
  /** Chat mode → explore mode upgrade, requested by the agent when the task
   * clearly needs exploration (modify/heal an adapter, probe a site's data
   * source) but the user didn't start in /explore. The driver asks the user
   * (write-confirm card; auto mode skips the ask), starts/resumes the explore
   * session, flips `mode` to 'explore', and returns a tool-result string for
   * the model (success guidance / decline / start failure). Absent in tests. */
  enterExploreMode?(reason: string): Promise<string>;
}

export interface AgentEngine {
  /** Stable identifier (e.g. 'api', future 'sidecar'). */
  readonly kind: string;
  run(ctx: EngineContext): Promise<void>;
}
