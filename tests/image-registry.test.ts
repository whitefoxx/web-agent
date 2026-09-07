/**
 * image-registry — [img_N] tokens for tool-result images, so a text-only
 * primary can view_image a screenshot whose bytes it never received (§10.25).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerImage,
  resolveImageRef,
  listImageIds,
  seedImageRegistry,
  __resetImageRegistry,
} from '../src/agent/image-registry';

beforeEach(() => __resetImageRegistry());

describe('image-registry', () => {
  it('registers with sequential ids and resolves both bare and bracketed tokens', () => {
    const id1 = registerImage('s1', 'data:image/png;base64,AAAA');
    const id2 = registerImage('s1', 'https://cdn/x.jpg');
    expect(id1).toBe('img_1');
    expect(id2).toBe('img_2');
    expect(resolveImageRef('s1', 'img_1')).toBe('data:image/png;base64,AAAA');
    expect(resolveImageRef('s1', '[img_2]')).toBe('https://cdn/x.jpg');
    expect(resolveImageRef('s1', '  img_2  ')).toBe('https://cdn/x.jpg');
  });

  it('same ref → same id (dedupe across re-collections)', () => {
    const a = registerImage('s1', 'data:image/png;base64,AAAA');
    const b = registerImage('s1', 'data:image/png;base64,AAAA');
    expect(b).toBe(a);
    expect(listImageIds('s1')).toEqual(['img_1']);
  });

  it('sessions are isolated', () => {
    registerImage('s1', 'data:image/png;base64,AAAA');
    expect(resolveImageRef('s2', 'img_1')).toBeNull();
    expect(listImageIds('s2')).toEqual([]);
  });

  it('unknown/garbage tokens resolve to null (clear error upstream, never a wrong image)', () => {
    expect(resolveImageRef('s1', 'img_99')).toBeNull();
    expect(resolveImageRef('s1', '[图片已省略]')).toBeNull();
    expect(resolveImageRef('s1', 'https://h/x.jpg')).toBeNull(); // not a token
  });

  it('seedImageRegistry re-seeds seq from history so a resumed session never re-mints a live id', () => {
    // Simulate SW teardown+resume: registry empty, but replayed history still
    // carries [img_1]/[img_2] tokens pointing at old screenshots.
    seedImageRegistry('s1', [
      'earlier tool result: screenshot [img_1] and [img_2] captured',
      '', // empty/blank history entries are skipped
    ]);
    // A NEW image must NOT reuse img_1/img_2 (which would silently resolve to it).
    const fresh = registerImage('s1', 'data:image/png;base64,NEW');
    expect(fresh).toBe('img_3');
    // The stale historical token resolves to null (graceful), never the new img.
    expect(resolveImageRef('s1', 'img_1')).toBeNull();
    expect(resolveImageRef('s1', 'img_3')).toBe('data:image/png;base64,NEW');
  });

  it('seedImageRegistry is idempotent and never lowers the counter', () => {
    registerImage('s1', 'data:image/png;base64,A'); // img_1
    seedImageRegistry('s1', ['img_0 img_1']); // lower/equal history → no regression
    const next = registerImage('s1', 'data:image/png;base64,B');
    expect(next).toBe('img_2');
  });

  it('caps per session, evicting oldest', () => {
    for (let i = 0; i < 30; i++) registerImage('s1', `https://cdn/${i}.jpg`);
    const ids = listImageIds('s1');
    expect(ids.length).toBe(24);
    expect(ids[0]).toBe('img_7'); // 1..6 evicted
    expect(resolveImageRef('s1', 'img_1')).toBeNull();
    expect(resolveImageRef('s1', 'img_30')).toBe('https://cdn/29.jpg');
  });

  it('LRU-touches a re-referenced image so it survives eviction (not pure FIFO)', () => {
    for (let i = 1; i <= 24; i++) registerImage('s1', `u${i}`); // fill to cap; img_1 oldest
    registerImage('s1', 'u1'); // re-reference → LRU touch moves img_1 to newest
    registerImage('s1', 'u25'); // evicts the now-oldest (img_2), NOT the touched img_1
    expect(resolveImageRef('s1', 'img_1')).toBe('u1'); // survived
    expect(resolveImageRef('s1', 'img_2')).toBeNull(); // evicted
  });
});
