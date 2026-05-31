/**
 * Port of opencli's clis/douyin/videos.test.js.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/videos.js';

describe('douyin/videos (marketplace)', () => {
  const command = findAdapter('douyin', 'videos');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the videos command', () => {
    expect(command).toBeDefined();
  });

  it('parses the current creator work_list api shape', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockResolvedValueOnce({
      aweme_list: [
        {
          aweme_id: '7000000000000000001',
          desc: '测试视频标题',
          create_time: 1581571130,
          statistics: {
            play_count: 0,
            digg_count: 12,
          },
          status: {
            is_private: true,
          },
        },
      ],
    });
    const rows = await command!.func!(page, { limit: 5, page: 1, status: 'all' });
    expect(rows).toEqual([
      {
        aweme_id: '7000000000000000001',
        title: '测试视频标题',
        status: 'private',
        play_count: 0,
        digg_count: 12,
        create_time: new Date(1581571130 * 1000).toLocaleString('zh-CN', {
          timeZone: 'Asia/Tokyo',
        }),
      },
    ]);
  });
});
