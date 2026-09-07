/**
 * Port of opencli's clis/linkedin/posts.test.js.
 *
 * Opencli's posts.test.js imports activityUrl/parseMetric/parseReactionText/
 * normalizePost from a SEPARATE module './posts-core.js'. In the marketplace
 * bundle, posts-core.js is INLINED into posts.js and those helpers are NOT
 * re-exported (activityUrl/normalizePost are file-local; parseMetric/
 * parseReactionText live only as string functions inside buildPostsScript()).
 * The bundle exports no __test__ either. Only the command-shape assertions are
 * reachable; the pure-helper assertions are recorded as skipped.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import '../../../marketplace/linkedin/posts.js';

describe('linkedin posts adapter', () => {
  const command = findAdapter('linkedin', 'posts');

  it('registers command shape', () => {
    expect(command).toBeDefined();
    expect(command!.strategy).toBe('cookie');
    expect(command!.browser).toBe(true);
    expect(command!.columns).toContain('reactions');
    expect(command!.columns).toContain('media_urls');
    expect(command!.columns).toContain('raw_text');
  });
});
