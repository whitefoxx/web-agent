/**
 * Step / token budget for the agent loop. Replaces the old hard maxIter=12
 * dead-stop: the model is TOLD its budget (so it paces itself), and hitting the
 * cap yields a graceful, resumable checkpoint instead of a bare
 * "max_iterations". Token figures come from the provider's `usage` (free, real)
 * and drive compaction (slice 3) + a last-resort overflow guard.
 *
 * Pure — see tests/budget.test.ts. docs/agent-harness.md §10.2.
 */

export interface BudgetConfig {
  /** Hard cap on completed steps (LLM turns) before a checkpoint. */
  maxSteps: number;
  /** prompt_tokens beyond which older history is compacted (wired in slice 3). */
  softTokenLimit: number;
  /** prompt_tokens beyond which we MUST checkpoint to avoid a context-overflow
   * 400 — a last-resort guard for when compaction can't claw back enough.
   * Model-dependent; tune toward the smallest context window you target. */
  hardTokenLimit: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxSteps: 40,
  softTokenLimit: 80_000,
  hardTokenLimit: 120_000,
};

export type BudgetVerdict = { stop: false } | { stop: true; reason: 'steps' | 'tokens' };

/** Whether to checkpoint BEFORE issuing the step numbered `step` (0-based count
 * of completed steps so far). `promptTokens` is the prompt_tokens reported by
 * the most recent response (0 before the first call). */
export function budgetVerdict(
  step: number,
  promptTokens: number,
  cfg: BudgetConfig = DEFAULT_BUDGET,
): BudgetVerdict {
  if (step >= cfg.maxSteps) return { stop: true, reason: 'steps' };
  if (promptTokens >= cfg.hardTokenLimit) return { stop: true, reason: 'tokens' };
  return { stop: false };
}

/** True once prompt_tokens crosses the soft limit → compact older history
 * before the next call (wired in slice 3). */
export function shouldCompact(promptTokens: number, cfg: BudgetConfig = DEFAULT_BUDGET): boolean {
  return promptTokens >= cfg.softTokenLimit;
}

/** Short note appended to the system prompt each step so the model knows its
 * remaining budget and paces itself (Claude-Code-style budget awareness). */
export function renderBudgetNote(step: number, cfg: BudgetConfig = DEFAULT_BUDGET): string {
  const remaining = Math.max(0, cfg.maxSteps - step);
  return (
    `\n\n## 步数预算\n本轮任务最多约 ${cfg.maxSteps} 个工具调用步骤,已用 ${step} 步,剩约 ${remaining} 步。` +
    `请据此规划:优先关键步骤、避免重复无效调用;若预算将尽仍未完成,先给用户阶段性结论与下一步建议,而不是空耗步数。`
  );
}
