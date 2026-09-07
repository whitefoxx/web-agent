/**
 * Port of opencli's clis/douyin/drafts.test.js (registration only).
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';

import '../../../marketplace/douyin/drafts.js';

describe('douyin/drafts (marketplace)', () => {
  const command = findAdapter('douyin', 'drafts');

  it('registers the drafts command', () => {
    expect(command).toBeDefined();
  });
});
