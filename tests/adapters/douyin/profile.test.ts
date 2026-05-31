/**
 * Port of opencli's clis/douyin/profile.test.js.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/profile.js';

describe('douyin/profile (marketplace)', () => {
  const command = findAdapter('douyin', 'profile');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the profile command', () => {
    expect(command).toBeDefined();
  });

  it('maps the current user payload shape returned by creator center', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockResolvedValueOnce({
      user: {
        uid: '100',
        nickname: 'creator',
        follower_count: 12,
        following_count: 3,
        aweme_count: 7,
      },
    });
    const rows = await command!.func!(page, {});
    expect(rows).toEqual([
      {
        uid: '100',
        nickname: 'creator',
        follower_count: 12,
        following_count: 3,
        aweme_count: 7,
      },
    ]);
  });
});
