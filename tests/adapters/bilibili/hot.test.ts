/**
 * Seed test for the marketplace-bundled adapter test pattern.
 *
 * Mirrors opencli's clis/bilibili/hot.test.js (structural assertion on the
 * pipeline shape). Difference vs. upstream:
 *   - opencli uses Map-style `getRegistry().get('site/name')`. Our registry
 *     returns an Array — use `findAdapter()` instead.
 *   - We import marketplace/bilibili/hot.js, not the upstream source. For
 *     pipeline adapters the bundled file is byte-identical to upstream
 *     (no relative imports, no esbuild step), so the assertions transfer
 *     verbatim — this test would catch any drift.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

// Side-effect import: cli({...}) at module top-level registers the adapter.
import '../../../marketplace/bilibili/hot.js';

describe('bilibili/hot (marketplace)', () => {
  const command = findAdapter('bilibili', 'hot');

  it('is registered', () => {
    expect(command).toBeTruthy();
    expect(command?.site).toBe('bilibili');
    expect(command?.name).toBe('hot');
  });

  it('exposes the public hot-list columns including bvid + url', () => {
    expect(command?.columns).toEqual(['rank', 'title', 'author', 'play', 'danmaku', 'bvid', 'url']);
  });

  it('keeps bvid + bvid-derived url in the evaluate stage', () => {
    const evalStep = (command?.pipeline as Array<{ evaluate?: string }>)?.[1];
    expect(evalStep?.evaluate).toContain('bvid: item.bvid');
    expect(evalStep?.evaluate).toContain("'https://www.bilibili.com/video/' + item.bvid");
  });

  it('forwards bvid + url through the map stage', () => {
    const mapStep = (command?.pipeline as Array<{ map?: Record<string, string> }>)?.[2];
    expect(mapStep?.map).toMatchObject({
      bvid: '${{ item.bvid }}',
      url: '${{ item.url }}',
    });
  });
});
