/**
 * Plan / todo artifact pure helpers (src/agent/plan.ts). docs §10.4.
 */
import { describe, expect, it } from 'vitest';
import {
  parsePlanSteps,
  planProgress,
  renderPlanBlock,
  seedPlan,
  type PlanState,
} from '../src/agent/plan';

describe('parsePlanSteps', () => {
  it('keeps valid steps and defaults bad status to pending', () => {
    const steps = parsePlanSteps([
      { title: '搜索', status: 'completed' },
      { title: '总结', status: 'bogus' },
      { title: '  ', status: 'pending' }, // empty title dropped
      { title: '抓取', status: 'in_progress', activeForm: '正在抓取' },
      'nope', // non-object dropped
    ]);
    expect(steps).toEqual([
      { title: '搜索', status: 'completed' },
      { title: '总结', status: 'pending' },
      { title: '抓取', status: 'in_progress', activeForm: '正在抓取' },
    ]);
  });
  it('returns [] for non-array input', () => {
    expect(parsePlanSteps(undefined)).toEqual([]);
    expect(parsePlanSteps('x')).toEqual([]);
  });
});

describe('seedPlan', () => {
  it('creates pending steps from titles + trims goal', () => {
    const p = seedPlan('  搞定小红书  ', ['看首页', '  ', '总结'], 123);
    expect(p).toEqual({
      goal: '搞定小红书',
      steps: [
        { title: '看首页', status: 'pending' },
        { title: '总结', status: 'pending' },
      ],
      updatedAt: 123,
    });
  });
  it('drops an empty goal to undefined', () => {
    expect(seedPlan('   ', ['a'], 1).goal).toBeUndefined();
  });
});

describe('planProgress', () => {
  it('counts completed vs total', () => {
    const p: PlanState = {
      steps: [
        { title: 'a', status: 'completed' },
        { title: 'b', status: 'in_progress' },
        { title: 'c', status: 'pending' },
      ],
      updatedAt: 0,
    };
    expect(planProgress(p)).toEqual({ completed: 1, total: 3 });
  });
  it('handles undefined', () => {
    expect(planProgress(undefined)).toEqual({ completed: 0, total: 0 });
  });
});

describe('renderPlanBlock', () => {
  it('renders a checklist with marks and progress', () => {
    const p: PlanState = {
      goal: '目标X',
      steps: [
        { title: 'a', status: 'completed' },
        { title: 'b', status: 'in_progress' },
        { title: 'c', status: 'pending' },
      ],
      updatedAt: 0,
    };
    const block = renderPlanBlock(p);
    expect(block).toContain('当前计划(1/3 完成)');
    expect(block).toContain('目标:目标X');
    expect(block).toContain('[x] a');
    expect(block).toContain('[~] b');
    expect(block).toContain('[ ] c');
  });
  it('is empty when there is no plan', () => {
    expect(renderPlanBlock(undefined)).toBe('');
    expect(renderPlanBlock({ steps: [], updatedAt: 0 })).toBe('');
  });
});
