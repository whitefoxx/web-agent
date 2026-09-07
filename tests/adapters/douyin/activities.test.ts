/**
 * Port of opencli's clis/douyin/activities.test.js.
 *
 * opencli mocks `browserFetch`; here it's inlined, so we intercept at
 * page.evaluate via makeFakeDouyinPage() and drive page.browserFetch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/activities.js';

describe('douyin/activities (marketplace)', () => {
  const command = findAdapter('douyin', 'activities');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the activities command', () => {
    expect(command).toBeDefined();
  });

  it('has expected columns', () => {
    expect(command?.columns).toContain('activity_id');
    expect(command?.columns).toContain('title');
    expect(command?.columns).toContain('end_time');
  });

  it('uses COOKIE strategy', () => {
    expect(command?.strategy).toBe('cookie');
  });

  it('maps the current activity payload shape returned by creator center', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockResolvedValueOnce({
      activity_list: [
        {
          activity_id: '200',
          activity_name: '超会玩派对',
          show_end_time: '2026.05.31',
        },
      ],
    });
    const rows = await command!.func!(page, {});
    expect(rows).toEqual([
      {
        activity_id: '200',
        title: '超会玩派对',
        end_time: '2026.05.31',
      },
    ]);
  });
});
