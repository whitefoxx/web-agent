/**
 * Port of opencli's clis/xiaohongshu/creator-stats.test.js.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { EmptyResultError } from '../../../src/runtime/errors.js';
import { makeFakeXiaohongshuPage } from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/creator-stats.js';

describe('xiaohongshu/creator-stats (marketplace)', () => {
  it('throws EmptyResultError when the requested stats period has no data', async () => {
    const cmd = findAdapter('xiaohongshu', 'creator-stats');
    const page = makeFakeXiaohongshuPage();
    page.evaluate.mockResolvedValue({
      data: {
        seven: null,
        thirty: {
          view_count: 1,
          view_list: [{ count: 1 }],
        },
      },
    });

    await expect(cmd!.func!(page, { period: 'seven' })).rejects.toBeInstanceOf(EmptyResultError);
  });
});
