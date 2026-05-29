/**
 * AgentEngine — the seam between the service worker (composition root) and the
 * different ways of driving a session.
 *
 * Two engines exist today:
 *   - the connector (chatbot-hijack) engine in `orchestrator.ts`, which is
 *     tab-bound and uses a `Driver` for inject / waitForResponse;
 *   - the `api` engine in `api-engine.ts`, which is tab-agnostic and talks to
 *     an OpenAI-compatible endpoint.
 *
 * A future Node-sidecar backend (real opencli, true plugin hot-plug) would be a
 * third `AgentEngine` that conforms to this same contract: it emits the shared
 * `OrchEvent` UI stream and executes tools through `executeTool`. Keeping that
 * contract here is what lets the service worker swap backends by config without
 * the SidePanel or the tool layer caring which engine ran.
 */

import type { OrchEvent, ToolExecResult } from './orchestrator';
import type { SessionState } from './session';

export interface EngineContext {
  session: SessionState;
  /** The user's message that starts this run. */
  userText: string;
  signal: AbortSignal;
  /** Resume a previously paused run (engine-specific semantics). */
  resume?: boolean;
  /** Follow-up turn inside an existing session. */
  continuation?: boolean;
  /** Emit a UI event. Both engines feed the same SidePanel stream. */
  emit(evt: OrchEvent): void;
  /** Run a tool by `site__name`. Shared dispatcher: per-site tab management,
   * pacing, and write-confirm gating live behind this. */
  executeTool(opts: { tool: string; args: Record<string, unknown> }): Promise<ToolExecResult>;
}

export interface AgentEngine {
  /** Stable identifier (e.g. 'api', 'connector', 'sidecar'). */
  readonly kind: string;
  run(ctx: EngineContext): Promise<void>;
}
