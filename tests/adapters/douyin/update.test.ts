/**
 * Port of opencli's clis/douyin/update.test.js (registration only).
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';

import '../../../marketplace/douyin/update.js';

describe('douyin/update (marketplace)', () => {
  const command = findAdapter('douyin', 'update');

  it('registers the update command', () => {
    expect(command).toBeDefined();
  });
});
