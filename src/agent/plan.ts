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

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
  /** Present-continuous label shown while the step is in_progress (TodoWrite's
   * activeForm), e.g. "正在抓取首页". Optional. */
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

const STATUSES: PlanStepStatus[] = ['pending', 'in_progress', 'completed'];

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

export interface PlanProgress {
  completed: number;
  total: number;
}

export function planProgress(plan: PlanState | undefined): PlanProgress {
  if (!plan) return { completed: 0, total: 0 };
  return {
    completed: plan.steps.filter((s) => s.status === 'completed').length,
    total: plan.steps.length,
  };
}

const MARK: Record<PlanStepStatus, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/** Compact markdown block injected into the system prompt each turn so the plan
 * stays the loop's persistent spine (anti-drift). Empty when there's no plan. */
export function renderPlanBlock(plan: PlanState | undefined): string {
  if (!plan || plan.steps.length === 0) return '';
  const { completed, total } = planProgress(plan);
  const lines = plan.steps.map((s) => `${MARK[s.status]} ${s.title}`);
  const goal = plan.goal ? `目标:${plan.goal}\n` : '';
  return (
    `\n\n## 当前计划(${completed}/${total} 完成)\n${goal}${lines.join('\n')}\n` +
    '随进展用 update_plan 更新这个清单:开始某步前标 in_progress,做完立刻标 completed,任何时候只保留一个 in_progress。'
  );
}
