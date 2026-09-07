/**
 * Plan / todo artifact pure helpers (src/agent/plan.ts). docs §10.4.
 */
import { describe, expect, it } from 'vitest';
import {
  looksLikeReplanRequest,
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
  it('accepts skipped and failed statuses (reason carried in activeForm)', () => {
    expect(
      parsePlanSteps([
        { title: '跳过的', status: 'skipped', activeForm: '前置条件不满足' },
        { title: '失败的', status: 'failed', activeForm: '接口 400' },
      ]),
    ).toEqual([
      { title: '跳过的', status: 'skipped', activeForm: '前置条件不满足' },
      { title: '失败的', status: 'failed', activeForm: '接口 400' },
    ]);
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
    expect(planProgress(p)).toEqual({ completed: 1, settled: 1, total: 3 });
  });
  it('counts skipped + failed as settled but not completed', () => {
    const p: PlanState = {
      steps: [
        { title: 'a', status: 'completed' },
        { title: 'b', status: 'skipped' },
        { title: 'c', status: 'failed' },
        { title: 'd', status: 'pending' },
      ],
      updatedAt: 0,
    };
    expect(planProgress(p)).toEqual({ completed: 1, settled: 3, total: 4 });
  });
  it('handles undefined', () => {
    expect(planProgress(undefined)).toEqual({ completed: 0, settled: 0, total: 0 });
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
    expect(block).toContain('Current plan (1/3 done)');
    expect(block).toContain('Goal: 目标X');
    expect(block).toContain('[x] a');
    expect(block).toContain('[~] b');
    expect(block).toContain('[ ] c');
  });
  it('renders distinct marks for skipped / failed', () => {
    const p: PlanState = {
      steps: [
        { title: 's', status: 'skipped' },
        { title: 'f', status: 'failed' },
      ],
      updatedAt: 0,
    };
    const block = renderPlanBlock(p);
    expect(block).toContain('[-] s');
    expect(block).toContain('[!] f');
  });
  it('is empty when there is no plan', () => {
    expect(renderPlanBlock(undefined)).toBe('');
    expect(renderPlanBlock({ steps: [], updatedAt: 0 })).toBe('');
  });
});

describe('looksLikeReplanRequest', () => {
  it('matches interjections asking for a confirmable plan', () => {
    expect(looksLikeReplanRequest('先给我一个计划确认一下')).toBe(true);
    expect(looksLikeReplanRequest('重新规划下')).toBe(true);
    expect(looksLikeReplanRequest('give me a plan to confirm')).toBe(true);
    expect(looksLikeReplanRequest('把计划列出来给我过目')).toBe(true);
  });
  it('ignores unrelated interjections', () => {
    expect(looksLikeReplanRequest('这个计划挺好的')).toBe(false); // plan word, no request verb
    expect(looksLikeReplanRequest('帮我总结一下')).toBe(false); // no plan word
    expect(looksLikeReplanRequest('')).toBe(false);
  });
});
