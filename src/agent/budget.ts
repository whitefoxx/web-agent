/**
 * Step / token budget for the agent loop. Replaces the old hard maxIter=12
 * dead-stop: the model is TOLD its budget (so it paces itself), and hitting the
 * cap yields a graceful, resumable checkpoint instead of a bare
 * "max_iterations". Token figures come from the provider's `usage` (free, real)
 * and drive compaction (slice 3) + a last-resort overflow guard.
 *
 * Pure — see tests/budget.test.ts. docs/agent-harness.md §10.2.
 */

import type { ApiMessage, ContentPart } from './api-types';

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

/** Rough prompt-token estimate from the message array, for providers that OMIT
 * `usage`. Without it, `lastPromptTokens` stays 0, so shouldCompact() and the
 * overflow guard silently disable — and a long run (each tool result up to 64KB,
 * up to maxSteps of them) overflows the context window → hard 400 with no
 * compaction ever attempted. ~4 chars/token for text + tool_call args; a flat
 * nominal per inline image (providers bill an image as a fixed block, NOT by its
 * base64 length — counting base64 chars would wildly overestimate). Deliberately
 * approximate: it only needs to be good enough to trip the soft/hard limits. */
export function estimatePromptTokens(messages: ApiMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content as ContentPart[]) {
        if (part.type === 'text') chars += part.text.length;
        else if (part.type === 'image_url') images += 1;
      }
    }
    const toolCalls = (m as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        try {
          chars += JSON.stringify(tc).length;
        } catch {
          /* unserializable — ignore */
        }
      }
    }
  }
  return Math.ceil(chars / 4) + images * 1000;
}

/** Short note appended to the system prompt each step so the model knows its
 * remaining budget and paces itself (Claude-Code-style budget awareness). */
export function renderBudgetNote(step: number, cfg: BudgetConfig = DEFAULT_BUDGET): string {
  const remaining = Math.max(0, cfg.maxSteps - step);
  return (
    `\n\n## Step budget\nThis task allows roughly ${cfg.maxSteps} tool-call steps at most; ${step} used, about ${remaining} left.` +
    ` Plan accordingly: prioritize the key steps and avoid repeated ineffective calls; if the budget is nearly spent and the task is not done, give the user an interim conclusion and next-step suggestions rather than burning steps for nothing.`
  );
}
