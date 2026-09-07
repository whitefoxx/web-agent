/**
 * Per-adapter experience notes (⑩): appendNote (cap + de-dupe) and toHealthId
 * (agent tool name `site__name` → health/note key `site/name`). Pure; node.
 */

import { describe, it, expect } from 'vitest';
import { appendNote, toHealthId, type AdapterNote } from '../src/adapters/adapter-health-store';

describe('appendNote (⑩)', () => {
  it('appends a trimmed note; skips empty', () => {
    expect(appendNote(undefined, '  site moved API to /v2  ', 100)).toEqual([
      { ts: 100, text: 'site moved API to /v2' },
    ]);
    expect(appendNote([], '   ', 1)).toEqual([]);
  });

  it('de-dupes a consecutive repeat of the last note', () => {
    const a = appendNote(undefined, 'x', 1);
    expect(appendNote(a, 'x', 2)).toEqual(a); // same as last → no-op
    expect(appendNote(a, 'y', 3)).toHaveLength(2); // different → appends
  });

  it('caps at 8, keeping the newest', () => {
    let n: AdapterNote[] | undefined;
    for (let i = 0; i < 12; i++) n = appendNote(n, 'note' + i, i);
    expect(n).toHaveLength(8);
    expect(n![0].text).toBe('note4');
    expect(n![7].text).toBe('note11');
  });
});

describe('toHealthId (⑩ / health key)', () => {
  it('site__name → site/name', () => {
    expect(toHealthId('zhihu__search')).toBe('zhihu/search');
    expect(toHealthId('my-github__hot_articles')).toBe('my-github/hot_articles');
  });

  it('generic and non-adapter tools → null', () => {
    expect(toHealthId('generic__open_url')).toBeNull();
    expect(toHealthId('open_url')).toBeNull();
    expect(toHealthId('nounderscore')).toBeNull();
  });
});
