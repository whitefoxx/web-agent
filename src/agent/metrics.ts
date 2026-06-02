/**
 * Per-run metrics (metrics-lite) — a structured tally of what a session run did
 * (steps, tool calls + errors, compactions, sub-agents, token usage, wall time),
 * logged to the `metrics` scope at the end of each run so it shows in the Logs
 * page. The pragmatic stand-in for full OpenTelemetry on a client-side
 * extension (no collector to ship spans to). Pure — see tests/metrics.test.ts.
 * docs/agent-harness.md §10.9.
 */

export interface RunMetrics {
  startedAt: number;
  /** Execution-loop iterations. */
  steps: number;
  /** Dispatched tool calls (excludes intercepted plan/subagent pseudo-tools). */
  toolCalls: number;
  toolErrors: number;
  /** Times the context was compacted. */
  compactions: number;
  /** Sub-agents spawned. */
  subagents: number;
  /** Most recent prompt_tokens (a proxy for context size). */
  promptTokens: number;
  /** Summed completion_tokens across main turns. */
  completionTokens: number;
}

export function newRunMetrics(startedAt: number): RunMetrics {
  return {
    startedAt,
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    compactions: 0,
    subagents: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

/** One-line human-readable summary for the metrics log. `endedAt` is passed in
 * (keeps this pure / testable). */
export function renderRunSummary(m: RunMetrics, endedAt: number, reason: string): string {
  const secs = ((endedAt - m.startedAt) / 1000).toFixed(1);
  return (
    `run done reason=${reason} ${secs}s · steps=${m.steps} ` +
    `tools=${m.toolCalls}(err ${m.toolErrors}) compactions=${m.compactions} ` +
    `subagents=${m.subagents} tokens≈${m.promptTokens}p/${m.completionTokens}c`
  );
}
