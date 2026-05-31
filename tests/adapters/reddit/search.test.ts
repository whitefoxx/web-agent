/**
 * Port of opencli's clis/reddit/search.test.js.
 *
 * search is a PIPELINE adapter (no func). Declarative assertions.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

import '../../../marketplace/reddit/search.js';

describe('reddit search adapter (marketplace)', () => {
  const command = findAdapter('reddit', 'search');

  it('exposes the full search-result shape including the 4 media columns', () => {
    expect(command?.columns).toEqual([
      'id', 'title', 'subreddit', 'author', 'score', 'comments', 'url',
      'created_utc', 'selftext',
      'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls',
    ]);
  });

  it('surfaces media via extractRedditMedia in evaluate + map', () => {
    expect(command?.pipeline?.[1]?.evaluate).toContain('function extractRedditMedia');
    expect(command?.pipeline?.[1]?.evaluate).toContain('...extractRedditMedia(c.data)');
    expect(command?.pipeline?.[2]?.map).toMatchObject({
      post_hint: '${{ item.post_hint }}',
      url_overridden_by_dest: '${{ item.url_overridden_by_dest }}',
      preview_image_url: '${{ item.preview_image_url }}',
      gallery_urls: '${{ item.gallery_urls }}',
    });
  });
});
