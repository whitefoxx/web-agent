/**
 * Context compaction pure helpers (src/agent/compaction.ts). docs §10.3.
 */
import { describe, expect, it } from 'vitest';
import type { ApiMessage } from '../src/agent/api-types';
import {
  applyCompaction,
  buildCompactionMessages,
  findCompactionBoundary,
  renderHistoryForSummary,
} from '../src/agent/compaction';

const U = (s: string): ApiMessage => ({ role: 'user', content: s });
const A = (s: string, tools?: string[]): ApiMessage => ({
  role: 'assistant',
  content: s,
  ...(tools
    ? {
        tool_calls: tools.map((t, i) => ({
          id: `c${i}`,
          type: 'function' as const,
          function: { name: t, arguments: '{}' },
        })),
      }
    : {}),
});
const T = (id: string, s: string): ApiMessage => ({ role: 'tool', tool_call_id: id, content: s });

describe('findCompactionBoundary', () => {
  it('returns 0 when history is within the keep window', () => {
    expect(findCompactionBoundary([U('a'), A('b')], 8)).toBe(0);
  });
  it('never cuts on a tool message (no orphaned tool result)', () => {
    const msgs: ApiMessage[] = [
      U('u1'),
      A('a1', ['x']),
      T('c0', 'r'),
      U('u2'),
      A('a2', ['y']),
      T('c0', 'r2'),
      U('u3'),
      A('a3', ['z']),
      T('c0', 'r3'),
      A('done'),
    ];
    const idx = findCompactionBoundary(msgs, 3);
    expect(idx).toBeGreaterThan(0);
    expect(msgs[idx]!.role).not.toBe('tool');
  });
  it('walks forward off a tool boundary, keeping the group intact', () => {
    // minKeep 5 → start idx 5 which is a tool → must advance to the next user.
    const msgs: ApiMessage[] = [
      U('u1'),
      A('a1', ['x']),
      T('c0', 'r'),
      U('u2'),
      A('a2', ['y']),
      T('c0', 'r2'),
      U('u3'),
      A('a3', ['z']),
      T('c0', 'r3'),
      A('done'),
    ];
    const idx = findCompactionBoundary(msgs, 5);
    expect(msgs[idx]!.role).not.toBe('tool');
  });
});

describe('applyCompaction', () => {
  it('splices older into one summary message, keeps recent verbatim', () => {
    const msgs: ApiMessage[] = [U('u1'), A('a1'), U('u2'), A('a2'), U('u3')];
    const removed = applyCompaction(msgs, 'SUMMARY', 3);
    expect(removed).toBe(2);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe('user');
    expect((msgs[0] as { content: string }).content).toContain('SUMMARY');
    expect(msgs[1]).toEqual(A('a2'));
    expect(msgs[2]).toEqual(U('u3'));
  });
  it('no-ops on a trivial boundary', () => {
    const msgs: ApiMessage[] = [U('a'), A('b')];
    expect(applyCompaction(msgs, 'S', 1)).toBe(0);
    expect(msgs).toHaveLength(2);
  });
});

describe('buildCompactionMessages', () => {
  it('asks for the structured sections', () => {
    const out = buildCompactionMessages([U('hi'), A('ok')]);
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    const u = out[1]!.content as string;
    expect(u).toContain('User intent');
    expect(u).toContain('Key data captured');
  });
});

describe('renderHistoryForSummary', () => {
  it('truncates long tool results', () => {
    const out = renderHistoryForSummary([T('c0', 'x'.repeat(5000))], 100);
    expect(out).toContain('…[truncated]');
    expect(out.length).toBeLessThan(5000);
  });
  it('labels roles and lists tool-call names', () => {
    const out = renderHistoryForSummary([U('hello'), A('world', ['tool_x'])]);
    expect(out).toContain('[User] hello');
    expect(out).toContain('[Assistant] world');
    expect(out).toContain('tool_x');
  });
});
