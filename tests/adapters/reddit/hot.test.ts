/**
 * Port of opencli's clis/reddit/hot.test.js.
 *
 * hot is a PIPELINE adapter (no func). Declarative assertions on the
 * registered definition; only the lookup mechanism changes.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';

import '../../../marketplace/reddit/hot.js';

describe('reddit hot adapter (marketplace)', () => {
  const command = findAdapter('reddit', 'hot');

  it('registers postId, author, and url columns in the hot-list shape', () => {
    expect(command?.columns).toEqual([
      'rank', 'title', 'subreddit', 'score', 'comments', 'postId', 'author', 'url',
      'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls',
    ]);
    expect(command?.pipeline?.[1]?.evaluate).toContain('postId: c.data.id');
    expect(command?.pipeline?.[1]?.evaluate).toContain("'https://www.reddit.com' + c.data.permalink");
    expect(command?.pipeline?.[2]?.map).toMatchObject({
      postId: '${{ item.postId }}',
      author: '${{ item.author }}',
      url: '${{ item.url }}',
    });
  });

  it('surfaces post_hint, url_overridden_by_dest, preview_image_url, gallery_urls via extractRedditMedia', () => {
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
