/**
 * Port of opencli's clis/twitter/trending.test.js.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

import '../../../marketplace/twitter/trending.js';

describe('twitter trending (marketplace)', () => {
  it('registers the trending command with rank/topic/category columns only', () => {
    const cmd = findAdapter('twitter', 'trending');
    expect(cmd).toBeDefined();
    expect(cmd!.columns).toEqual(['rank', 'topic', 'category']);
    expect(cmd!.columns).not.toContain('tweets');
  });
});
