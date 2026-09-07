/**
 * Per-run metrics pure helpers (src/agent/metrics.ts). docs §10.9.
 */
import { describe, expect, it } from 'vitest';
import { newRunMetrics, renderRunSummary } from '../src/agent/metrics';

describe('newRunMetrics', () => {
  it('zeroes all counters', () => {
    expect(newRunMetrics(1000)).toEqual({
      startedAt: 1000,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      compactions: 0,
      subagents: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
  });
});

describe('renderRunSummary', () => {
  it('formats a one-liner with reason, timing, and counters', () => {
    const m = newRunMetrics(1000);
    m.steps = 3;
    m.toolCalls = 5;
    m.toolErrors = 1;
    m.compactions = 1;
    m.subagents = 2;
    m.promptTokens = 1234;
    m.completionTokens = 567;
    const s = renderRunSummary(m, 1000 + 4200, 'no_more_commands');
    expect(s).toContain('reason=no_more_commands');
    expect(s).toContain('4.2s');
    expect(s).toContain('steps=3');
    expect(s).toContain('tools=5(err 1)');
    expect(s).toContain('compactions=1');
    expect(s).toContain('subagents=2');
    expect(s).toContain('1234p/567c');
  });
});
