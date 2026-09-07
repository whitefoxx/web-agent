/**
 * Plan / todo artifact — the living checklist the agent maintains across a long
 * loop (Phase 1). Mirrors Claude Code's TodoWrite: the model re-sends the FULL
 * step list each update (not deltas), keeps exactly one step in_progress, and
 * marks a step completed the moment it's done. Rendered into the system prompt
 * each turn as the loop's "spine" (anti-drift) and surfaced live in the UI.
 *
 * In plan mode (Phase 2) an approved submit_plan seeds these steps; in chat mode
 * the model calls update_plan directly. Pure — see tests/plan.test.ts.
 * docs/agent-harness.md §10.4.
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  /** Free-text note: the present-continuous label while in_progress (TodoWrite's
   * activeForm, e.g. "Fetching the home page"), or a one-line reason when the step
   * ends up skipped / failed. Optional. */
  activeForm?: string;
}

export interface PlanState {
  /** Optional one-line goal (set by submit_plan in plan mode). */
  goal?: string;
  steps: PlanStep[];
  updatedAt: number;
  /** True once the user approved this plan (plan mode). */
  approved?: boolean;
}

const STATUSES: PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'skipped', 'failed'];

/** Coerce raw tool args (untrusted model output) into clean PlanSteps. Drops
 * entries without a title; defaults a bad/missing status to 'pending'. */
export function parsePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) continue;
    const status = STATUSES.includes(o.status as PlanStepStatus)
      ? (o.status as PlanStepStatus)
      : 'pending';
    const activeForm = typeof o.activeForm === 'string' ? o.activeForm.trim() : '';
    out.push({ title, status, ...(activeForm ? { activeForm } : {}) });
  }
  return out;
}

/** Build a PlanState from step titles (used by submit_plan in plan mode). */
export function seedPlan(goal: string, titles: unknown[], now: number): PlanState {
  return {
    goal: goal.trim() || undefined,
    steps: (Array.isArray(titles) ? titles : [])
      .map((t) => (typeof t === 'string' ? t.trim() : ''))
      .filter(Boolean)
      .map((title) => ({ title, status: 'pending' as const })),
    updatedAt: now,
  };
}

/** A step has reached a terminal/settled state — it won't change again and the
 * loop shouldn't keep nagging about it. Truthful: completed ≠ skipped ≠ failed. */
export function isTerminal(status: PlanStepStatus): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed';
}

export interface PlanProgress {
  /** Steps that genuinely succeeded. */
  completed: number;
  /** Steps that reached any terminal state (completed + skipped + failed). */
  settled: number;
  total: number;
}

export function planProgress(plan: PlanState | undefined): PlanProgress {
  if (!plan) return { completed: 0, settled: 0, total: 0 };
  return {
    completed: plan.steps.filter((s) => s.status === 'completed').length,
    settled: plan.steps.filter((s) => isTerminal(s.status)).length,
    total: plan.steps.length,
  };
}

const MARK: Record<PlanStepStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
  skipped: '[-]',
  failed: '[!]',
};

/** Compact markdown block injected into the system prompt each turn so the plan
 * stays the loop's persistent spine (anti-drift). Empty when there's no plan. */
export function renderPlanBlock(plan: PlanState | undefined): string {
  if (!plan || plan.steps.length === 0) return '';
  const { completed, total } = planProgress(plan);
  const lines = plan.steps.map((s) => `${MARK[s.status]} ${s.title}`);
  const goal = plan.goal ? `Goal: ${plan.goal}\n` : '';
  return (
    `\n\n## Current plan (${completed}/${total} done)\n${goal}${lines.join('\n')}\n` +
    'Keep this checklist truthfully up to date with update_plan as you go: mark a step in_progress before starting it, and completed the moment it is done; mark steps you deliberately skip as skipped and failed attempts as failed (write a one-line reason in activeForm for each). Keep exactly one step in_progress at any time, and never mark an undone step as completed. Once everything is finished, first call update_plan on its own to mark the last step done, then give your [complete, detailed] final answer in a separate message with no tool calls — do not cram the conclusion and update_plan into the same message.'
  );
}

/** Heuristic: does a mid-run interjection ask the agent to (re)produce a plan
 * for the user to confirm? Intent is detected from the steer text (the user
 * opted into this over a dedicated button). Deliberately loose — a false
 * positive just shows an extra approvable plan, which the user can reject.
 * docs/agent-harness.md §10.16. */
export function looksLikeReplanRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const hasPlan = /计划|规划|plan/i.test(t);
  const hasWant = /确认|确定|过目|审|先给|给我|列出|重新|改成|改个|review|confirm/i.test(t);
  return hasPlan && hasWant;
}
