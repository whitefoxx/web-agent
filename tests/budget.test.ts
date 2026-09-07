/**
 * Step/token budget primitives (src/agent/budget.ts). docs/agent-harness.md §10.2.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  budgetVerdict,
  estimatePromptTokens,
  renderBudgetNote,
  shouldCompact,
} from '../src/agent/budget';
import type { ApiMessage } from '../src/agent/api-types';

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
    expect(note).toContain('Step budget');
    expect(note).toContain('3 used');
    expect(note).toContain('about 7 left');
  });
  it('never goes negative past the cap', () => {
    expect(renderBudgetNote(12, { maxSteps: 10, softTokenLimit: 1, hardTokenLimit: 2 })).toContain(
      'about 0 left',
    );
  });
  it('ships sane defaults', () => {
    expect(DEFAULT_BUDGET.maxSteps).toBe(40);
  });
});

describe('estimatePromptTokens (usage-absent fallback)', () => {
  it('estimates text content at ~4 chars/token', () => {
    const msgs: ApiMessage[] = [
      { role: 'system', content: 'x'.repeat(400) },
      { role: 'user', content: 'y'.repeat(400) },
    ];
    expect(estimatePromptTokens(msgs)).toBe(200); // 800 chars / 4
  });

  it('counts text parts + a flat 1000/image, NOT the base64 length', () => {
    const msgs: ApiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'z'.repeat(40) },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100_000) } },
        ],
      },
    ];
    // 40/4=10 + 1000 per image; the 100k base64 chars are deliberately ignored.
    expect(estimatePromptTokens(msgs)).toBe(1010);
  });

  it('includes assistant tool_call args', () => {
    const msgs: ApiMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }],
      },
    ];
    expect(estimatePromptTokens(msgs)).toBeGreaterThan(0);
  });

  it('empty → 0', () => {
    expect(estimatePromptTokens([])).toBe(0);
  });
});
