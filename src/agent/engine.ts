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

import type { ParsedCommand, ToolTrace, PlanDecision } from '../messages';
import type { SessionState } from './session';
import type { PlanState } from './plan';

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
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
    };

export interface EngineContext {
  session: SessionState;
  /** The user's message that starts this run. */
  userText: string;
  signal: AbortSignal;
  /** Follow-up turn inside an existing session. */
  continuation?: boolean;
  /** Plan mode for this run; 'plan' = research read-only → propose → approve →
   * execute. Defaults to 'chat' (execute directly). */
  mode?: 'chat' | 'plan';
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
  /** Drain any messages the user injected mid-run (steering); [] if none. */
  takeSteerMessages(): string[];
}

export interface AgentEngine {
  /** Stable identifier (e.g. 'api', future 'sidecar'). */
  readonly kind: string;
  run(ctx: EngineContext): Promise<void>;
}
