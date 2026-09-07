/**
 * shortcuts store (T5) — CRUD over chrome.storage.local.
 * Uses a minimal chrome.storage stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listShortcuts, saveShortcut, deleteShortcut, type Shortcut } from '../src/shortcuts/store';

function stubStorage() {
  let data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: data[key] }),
        set: async (obj: Record<string, unknown>) => {
          data = { ...data, ...obj };
        },
      },
    },
  });
}

const mk = (over: Partial<Shortcut>): Shortcut => ({
  id: over.id ?? 'a',
  label: over.label ?? 'A',
  kind: over.kind ?? 'prompt',
  ...over,
});

describe('shortcuts store', () => {
  beforeEach(() => stubStorage());

  it('starts empty', async () => {
    expect(await listShortcuts()).toEqual([]);
  });

  it('saves and lists (append + upsert by id)', async () => {
    await saveShortcut(mk({ id: 'a', label: 'A' }));
    await saveShortcut(mk({ id: 'b', label: 'B' }));
    await saveShortcut(mk({ id: 'a', label: 'A2' })); // upsert
    const list = await listShortcuts();
    expect(list.map((s) => [s.id, s.label])).toEqual([
      ['a', 'A2'],
      ['b', 'B'],
    ]);
  });

  it('deletes by id', async () => {
    await saveShortcut(mk({ id: 'a' }));
    await saveShortcut(mk({ id: 'b' }));
    await deleteShortcut('a');
    expect((await listShortcuts()).map((s) => s.id)).toEqual(['b']);
  });
});
