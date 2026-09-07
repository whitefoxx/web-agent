/**
 * notes-store — pure helpers + execNotesAction's arg validation (the paths that
 * fail BEFORE touching IndexedDB, since the node test env has no IDB — same
 * stance as memory-store). Also covers memory-store's renderMemoryExport.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveNoteTitle,
  noteExcerpt,
  matchNotes,
  renderNotesExport,
  execNotesAction,
  NOTES_WRITE_ACTIONS,
  type Note,
} from '../src/agent/notes-store';
import { renderMemoryExport } from '../src/agent/memory-store';

function note(p: Partial<Note>): Note {
  return {
    id: 'n_1',
    title: 't',
    content: 'c',
    source: 'user',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...p,
  };
}

describe('deriveNoteTitle', () => {
  it('takes the first non-empty line, stripped of markdown decoration', () => {
    expect(deriveNoteTitle('# 今天的调研\n\n正文…')).toBe('今天的调研');
    expect(deriveNoteTitle('\n\n- **要点**:[链接](https://x.com) 很重要')).toBe('要点:链接 很重要');
    expect(deriveNoteTitle('![封面](https://img/x.png)\n正文')).toBe('封面');
  });
  it('caps long titles and falls back when content is blank', () => {
    const long = 'x'.repeat(80);
    expect(deriveNoteTitle(long)).toBe(`${'x'.repeat(60)}…`);
    expect(deriveNoteTitle('   \n\n')).toBe('Untitled note');
  });
});

describe('noteExcerpt', () => {
  it('flattens markdown to plain text and caps length', () => {
    expect(noteExcerpt('# 标题\n\n- 第一点\n- [第二点](https://a)')).toBe('标题 第一点 第二点');
    expect(noteExcerpt(`${'好'.repeat(200)}`, 10)).toBe(`${'好'.repeat(10)}…`);
  });
});

describe('matchNotes', () => {
  const notes = [
    note({ id: 'a', title: 'MV3 笔记', content: 'service worker 细节' }),
    note({ id: 'b', title: '菜谱', content: '西红柿炒蛋' }),
  ];
  it('matches title or content, case-insensitive; empty query returns all', () => {
    expect(matchNotes(notes, 'mv3').map((n) => n.id)).toEqual(['a']);
    expect(matchNotes(notes, 'WORKER').map((n) => n.id)).toEqual(['a']);
    expect(matchNotes(notes, '西红柿').map((n) => n.id)).toEqual(['b']);
    expect(matchNotes(notes, '  ')).toHaveLength(2);
    expect(matchNotes(notes, '不存在')).toHaveLength(0);
  });
});

describe('renderNotesExport', () => {
  it('renders one markdown doc with per-note meta', () => {
    const md = renderNotesExport([
      note({ title: 'A', content: '正文A', createdAt: 1700000000000, updatedAt: 1700086400000 }),
    ]);
    expect(md).toContain('# My Notes (1)');
    expect(md).toContain('## A');
    expect(md).toContain('Created 2023-11-14');
    expect(md).toContain('Updated 2023-11-15');
    expect(md).toContain('正文A');
  });
});

describe('renderMemoryExport', () => {
  it('renders the memory document with a dated heading', () => {
    const md = renderMemoryExport({
      enabled: true,
      content: '偏好简洁回答',
      updatedAt: 1700000000000,
    });
    expect(md).toContain('# My Memory (updated 2023-11-14)');
    expect(md).toContain('偏好简洁回答');
  });
});

describe('execNotesAction arg validation (fails before IDB)', () => {
  it('rejects unknown / missing action with the action list', async () => {
    const r = await execNotesAction({ action: 'frobnicate' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('create / list / search / get / update / delete');
    expect((await execNotesAction({})).ok).toBe(false);
  });
  it('create requires non-empty content', async () => {
    expect((await execNotesAction({ action: 'create' })).ok).toBe(false);
    expect((await execNotesAction({ action: 'create', content: '  ' })).ok).toBe(false);
  });
  it('search requires query; get/update/delete require id', async () => {
    expect((await execNotesAction({ action: 'search' })).ok).toBe(false);
    expect((await execNotesAction({ action: 'get' })).ok).toBe(false);
    expect((await execNotesAction({ action: 'delete' })).ok).toBe(false);
    const up = await execNotesAction({ action: 'update' });
    expect(up.ok).toBe(false);
  });
  it('update with only a title passes the arg guard (reaches the store path)', async () => {
    // No IDB in node, so the store path returns ok:false — but the point is it
    // did NOT trip the "needs title or content" guard, i.e. title-only is valid.
    const r = await execNotesAction({ action: 'update', id: 'n_x', title: 'New Title' });
    expect(r.error).not.toContain('title 或 content');
  });

  it('update with id but no patch fields is rejected', async () => {
    const r = await execNotesAction({ action: 'update', id: 'n_x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('title or content');
  });
});

describe('NOTES_WRITE_ACTIONS', () => {
  it('marks exactly the mutating actions (bridge write-gate contract)', () => {
    expect([...NOTES_WRITE_ACTIONS].sort()).toEqual(['create', 'delete', 'update']);
    expect(NOTES_WRITE_ACTIONS.has('list')).toBe(false);
    expect(NOTES_WRITE_ACTIONS.has('search')).toBe(false);
    expect(NOTES_WRITE_ACTIONS.has('get')).toBe(false);
  });
});
