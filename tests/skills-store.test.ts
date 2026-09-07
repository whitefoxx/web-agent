/**
 * Skills store render helper (src/skills/store.ts). The chrome.storage CRUD
 * isn't tested here (no chrome in node); the pure `renderSkillsBlock` is. Skills
 * are advertised name+description only (progressive disclosure) — bodies load on
 * demand via use_skill.
 */
import { describe, expect, it } from 'vitest';
import { renderSkillsBlock, type Skill } from '../src/skills/store';

const sk = (name: string, description: string, body = 'do things'): Skill => ({
  id: name,
  name,
  description,
  body,
});

describe('renderSkillsBlock', () => {
  it('advertises name + description, not the body', () => {
    const b = renderSkillsBlock([sk('发帖', '在小红书发一条笔记', '很长的正文步骤…')]);
    expect(b).toContain('Available skills');
    expect(b).toContain('use_skill');
    expect(b).toContain('发帖: 在小红书发一条笔记');
    expect(b).not.toContain('很长的正文步骤');
  });
  it('is empty with no usable skills', () => {
    expect(renderSkillsBlock([])).toBe('');
    // name or body blank → not usable
    expect(
      renderSkillsBlock([sk('', 'x'), { id: 'a', name: 'a', description: 'd', body: '' }]),
    ).toBe('');
  });
  it('falls back when a description is missing', () => {
    const b = renderSkillsBlock([sk('x', '')]);
    expect(b).toContain('x: (no description)');
  });
});
