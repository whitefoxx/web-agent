/**
 * Long-term memory render helper (src/agent/memory-store.ts). docs §10.10.
 * The IDB CRUD isn't tested here (no IndexedDB in node, same as session-store).
 */
import { describe, expect, it } from 'vitest';
import { renderMemoryBlock, type MemoryFact } from '../src/agent/memory-store';

const f = (text: string, createdAt = 0): MemoryFact => ({ id: text, text, createdAt });

describe('renderMemoryBlock', () => {
  it('renders facts as a bulleted block', () => {
    const b = renderMemoryBlock([f('喜欢简洁回答'), f('常用小红书')]);
    expect(b).toContain('长期记忆');
    expect(b).toContain('- 喜欢简洁回答');
    expect(b).toContain('- 常用小红书');
  });
  it('is empty when there are no facts', () => {
    expect(renderMemoryBlock([])).toBe('');
  });
  it('caps the number of facts', () => {
    const many = Array.from({ length: 30 }, (_, i) => f(`fact${i}`));
    const b = renderMemoryBlock(many, 5);
    expect(b).toContain('fact4');
    expect(b).not.toContain('fact5');
  });
});
