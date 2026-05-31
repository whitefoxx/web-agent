/**
 * Port of opencli's clis/douyin/collections.test.js.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/collections.js';

describe('douyin/collections (marketplace)', () => {
  const command = findAdapter('douyin', 'collections');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the collections command', () => {
    expect(command).toBeDefined();
    expect(command?.args.some((a: { name: string }) => a.name === 'limit')).toBe(true);
  });

  it('has expected columns', () => {
    expect(command?.columns).toContain('mix_id');
    expect(command?.columns).toContain('name');
    expect(command?.columns).toContain('item_count');
  });

  it('uses COOKIE strategy', () => {
    expect(command?.strategy).toBe('cookie');
  });

  it('uses the current mix list request shape', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockResolvedValueOnce({ mix_list: [] });
    const rows = await command!.func!(page, { limit: 12 });
    expect(page.browserFetch).toHaveBeenCalledWith(
      page,
      'GET',
      'https://creator.douyin.com/web/api/mix/list/?status=0,1,2,3,6&count=12&cursor=0&should_query_new_mix=1&device_platform=web&aid=1128',
    );
    expect(rows).toEqual([]);
  });
});
