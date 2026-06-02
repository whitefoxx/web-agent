/**
 * Step/token budget primitives (src/agent/budget.ts). docs/agent-harness.md §10.2.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  budgetVerdict,
  renderBudgetNote,
  shouldCompact,
} from '../src/agent/budget';

describe('budgetVerdict', () => {
  const cfg = { maxSteps: 5, softTokenLimit: 100, hardTokenLimit: 200 };
  it('keeps going while under both limits', () => {
    expect(budgetVerdict(0, 0, cfg)).toEqual({ stop: false });
    expect(budgetVerdict(4, 199, cfg)).toEqual({ stop: false });
  });
  it('stops at the step cap', () => {
    expect(budgetVerdict(5, 0, cfg)).toEqual({ stop: true, reason: 'steps' });
    expect(budgetVerdict(6, 0, cfg)).toEqual({ stop: true, reason: 'steps' });
  });
  it('stops at the hard token limit', () => {
    expect(budgetVerdict(2, 200, cfg)).toEqual({ stop: true, reason: 'tokens' });
  });
  it('step cap takes priority over tokens', () => {
    expect(budgetVerdict(5, 999, cfg)).toEqual({ stop: true, reason: 'steps' });
  });
});

describe('shouldCompact', () => {
  const cfg = { maxSteps: 5, softTokenLimit: 100, hardTokenLimit: 200 };
  it('triggers at/after the soft limit', () => {
    expect(shouldCompact(99, cfg)).toBe(false);
    expect(shouldCompact(100, cfg)).toBe(true);
    expect(shouldCompact(150, cfg)).toBe(true);
  });
});

describe('renderBudgetNote', () => {
  it('reports used + remaining steps and is labelled', () => {
    const note = renderBudgetNote(3, { maxSteps: 10, softTokenLimit: 1, hardTokenLimit: 2 });
    expect(note).toContain('步数预算');
    expect(note).toContain('已用 3 步');
    expect(note).toContain('剩约 7 步');
  });
  it('never goes negative past the cap', () => {
    expect(renderBudgetNote(12, { maxSteps: 10, softTokenLimit: 1, hardTokenLimit: 2 })).toContain(
      '剩约 0 步',
    );
  });
  it('ships sane defaults', () => {
    expect(DEFAULT_BUDGET.maxSteps).toBe(40);
  });
});
