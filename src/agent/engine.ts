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

import type { ParsedCommand, ToolTrace } from '../messages';
import type { SessionState } from './session';

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
  | 'error'
  | 'user_abort';

export type IterationPhase = 'starting' | 'injecting' | 'awaiting' | 'completed';

export type OrchEvent =
  | {
      type: 'assistant_turn';
      iteration: number;
      cleanedText: string;
      rawText?: string;
      reasoningText?: string;
      commands: ParsedCommand[];
    }
  | { type: 'tool_trace'; trace: ToolTrace }
  | {
      type: 'iteration_progress';
      iteration: number;
      iterationId: string;
      phase: IterationPhase;
    }
  | {
      type: 'session_done';
      reason: SessionDoneReason;
      error?: string;
    };

export interface EngineContext {
  session: SessionState;
  /** The user's message that starts this run. */
  userText: string;
  signal: AbortSignal;
  /** Follow-up turn inside an existing session. */
  continuation?: boolean;
  /** Emit a UI event. */
  emit(evt: OrchEvent): void;
  /** Run a tool by `site__name`. Shared dispatcher: per-site tab management,
   * pacing, and write-confirm gating live behind this. */
  executeTool(opts: { tool: string; args: Record<string, unknown> }): Promise<ToolExecResult>;
}

export interface AgentEngine {
  /** Stable identifier (e.g. 'api', future 'sidecar'). */
  readonly kind: string;
  run(ctx: EngineContext): Promise<void>;
}
