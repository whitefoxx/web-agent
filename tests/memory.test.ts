/**
 * Long-term memory render helper (src/agent/memory-store.ts). docs §10.10.
 * The chrome.storage CRUD isn't tested here (no chrome in node); the pure
 * renderers are. Memory is a SINGLE markdown document (reworked 2026-07-17).
 */
import { describe, expect, it } from 'vitest';
import { renderMemoryBlock, type MemoryState } from '../src/agent/memory-store';

const state = (content: string, enabled = true): MemoryState => ({
  enabled,
  content,
  updatedAt: 0,
});

describe('renderMemoryBlock', () => {
  it('renders the document under a heading', () => {
    const b = renderMemoryBlock(state('喜欢简洁回答\n常用小红书'));
    expect(b).toContain('long-term memory');
    expect(b).toContain('喜欢简洁回答');
    expect(b).toContain('常用小红书');
  });
  it('is empty when the content is blank', () => {
    expect(renderMemoryBlock(state(''))).toBe('');
    expect(renderMemoryBlock(state('   \n  '))).toBe('');
  });
  it('is empty when memory is disabled (even with content)', () => {
    expect(renderMemoryBlock(state('有内容', false))).toBe('');
  });
  it('caps the injected length', () => {
    const long = 'x'.repeat(5000);
    const b = renderMemoryBlock(state(long), 100);
    expect(b).toContain('…(truncated)');
    expect(b.length).toBeLessThan(400);
  });
});
