import { describe, it, expect } from 'vitest';
import { getRegistry } from '../src/runtime/registry.js';
// Side-effect import: each adapter's top-level cli({...}) registers it.
import '../src/tools/xiaohongshu/_all';

describe('xiaohongshu adapter registration', () => {
  it('imports all expected adapters', () => {
    const xhs = getRegistry().filter((a) => a.site === 'xiaohongshu');
    const names = xhs.map((a) => a.name).sort();
    expect(names).toEqual([
      'comment-create',
      'comments',
      'creator-note-detail',
      'creator-notes',
      'creator-notes-summary',
      'creator-profile',
      'creator-stats',
      'download',
      'feed',
      'note',
      'notifications',
      'publish',
      'search',
      'user',
    ]);
  });

  it('each registered adapter has func + description + args[]', () => {
    const xhs = getRegistry().filter((a) => a.site === 'xiaohongshu');
    expect(xhs.length).toBeGreaterThan(0);
    for (const a of xhs) {
      expect(typeof a.func).toBe('function');
      expect(typeof a.description).toBe('string');
      expect(a.description!.length).toBeGreaterThan(0);
      expect(Array.isArray(a.args)).toBe(true);
    }
  });
});
