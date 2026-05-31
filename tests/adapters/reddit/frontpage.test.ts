/**
 * Port of opencli's clis/reddit/frontpage.test.js.
 *
 * frontpage is a PIPELINE adapter (no func). The test asserts on the
 * registered definition: columns + pipeline[1].evaluate + pipeline[2].map.
 * Only the lookup mechanism (getRegistry().get → findAdapter) changes.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

import '../../../marketplace/reddit/frontpage.js';

describe('reddit frontpage adapter (marketplace)', () => {
  const command = findAdapter('reddit', 'frontpage');

  it('exposes the full frontpage shape including the 4 media columns', () => {
    expect(command?.columns).toEqual([
      'title', 'subreddit', 'author', 'upvotes', 'comments', 'url',
      'post_hint', 'url_overridden_by_dest', 'preview_image_url', 'gallery_urls',
    ]);
  });

  it('shapes children into the intermediate-object pattern with media spread in', () => {
    expect(command?.pipeline?.[1]?.evaluate).toContain('function extractRedditMedia');
    expect(command?.pipeline?.[1]?.evaluate).toContain('...extractRedditMedia(c.data)');
    expect(command?.pipeline?.[1]?.evaluate).toContain('/r/all.json?limit=${{ args.limit }}&raw_json=1');
    expect(command?.pipeline?.[2]?.map).toMatchObject({
      title: '${{ item.title }}',
      subreddit: '${{ item.subreddit }}',
      author: '${{ item.author }}',
      upvotes: '${{ item.upvotes }}',
      comments: '${{ item.comments }}',
      url: '${{ item.url }}',
      post_hint: '${{ item.post_hint }}',
      url_overridden_by_dest: '${{ item.url_overridden_by_dest }}',
      preview_image_url: '${{ item.preview_image_url }}',
      gallery_urls: '${{ item.gallery_urls }}',
    });
  });
});
