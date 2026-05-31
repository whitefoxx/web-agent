/**
 * Port of opencli's clis/douyin/user-videos.test.js.
 *
 * opencli mocks the `./_shared/public-api.js` helpers
 * (fetchDouyinUserVideos / fetchDouyinComments). Those are INLINED in the
 * bundled adapter, but they both flow through the inlined browserFetch ->
 * page.evaluate -> page.browserFetch seam, so we drive page.browserFetch and
 * route on the request URL:
 *   - .../aweme/v1/web/aweme/post/  -> user videos list (resolve { aweme_list })
 *   - .../aweme/v1/web/comment/list/ -> comments         (resolve { comments })
 *
 * The opencli assertions on the helper call args
 *   fetchDouyinUserVideos(page, secUid, MAX_USER_VIDEOS_LIMIT)
 *   fetchDouyinComments(page, '1', DEFAULT_COMMENT_LIMIT)
 * are preserved by asserting the clamped count + ids landed in the request URL
 * the inlined helpers build.
 *
 * The pure-helper tests (normalizeUserVideosLimit / normalizeCommentLimit /
 * MAX_USER_VIDEOS_LIMIT / DEFAULT_COMMENT_LIMIT) ARE reachable: the bundled
 * file re-exports them, so we import them directly.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { CommandExecutionError, EmptyResultError } from '../../../src/runtime/errors.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import {
  DEFAULT_COMMENT_LIMIT,
  MAX_USER_VIDEOS_LIMIT,
  normalizeCommentLimit,
  normalizeUserVideosLimit,
} from '../../../marketplace/douyin/user-videos.js';

describe('douyin/user-videos (marketplace)', () => {
  const command = findAdapter('douyin', 'user-videos');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the command', () => {
    expect(command).toBeDefined();
  });

  it('clamps limit to a safe maximum', () => {
    expect(normalizeUserVideosLimit(100)).toBe(MAX_USER_VIDEOS_LIMIT);
    expect(normalizeUserVideosLimit(0)).toBe(1);
    expect(normalizeCommentLimit(99)).toBe(DEFAULT_COMMENT_LIMIT);
  });

  it('uses shared public-api helpers and applies clamped limits', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockImplementation(async (_p, _method, url: string) => {
      if (url.includes('/aweme/v1/web/aweme/post/')) {
        return {
          aweme_list: [
            {
              aweme_id: '1',
              desc: 'test video',
              video: { duration: 1234, play_addr: { url_list: ['https://example.com/video.mp4'] } },
              statistics: { digg_count: 9 },
            },
          ],
        };
      }
      if (url.includes('/aweme/v1/web/comment/list/')) {
        return { comments: [{ text: 'nice', digg_count: 3, user: { nickname: 'alice' } }] };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const rows = await command!.func!(page, {
      sec_uid: 'MS4w-test',
      limit: 100,
      comment_limit: 99,
      with_comments: true,
    });

    // Preserves opencli's fetchDouyinUserVideos(page, 'MS4w-test', MAX=20)
    const videosUrl = page.browserFetch.mock.calls.find((c) =>
      String(c[2]).includes('/aweme/v1/web/aweme/post/'),
    )?.[2] as string;
    expect(videosUrl).toContain('sec_user_id=MS4w-test');
    expect(videosUrl).toContain(`count=${MAX_USER_VIDEOS_LIMIT}`);

    // Preserves opencli's fetchDouyinComments(page, '1', DEFAULT=10)
    const commentsUrl = page.browserFetch.mock.calls.find((c) =>
      String(c[2]).includes('/aweme/v1/web/comment/list/'),
    )?.[2] as string;
    expect(commentsUrl).toContain('aweme_id=1');
    expect(commentsUrl).toContain(`count=${DEFAULT_COMMENT_LIMIT}`);

    expect(rows).toEqual([
      {
        index: 1,
        aweme_id: '1',
        title: 'test video',
        duration: 1,
        digg_count: 9,
        play_url: 'https://example.com/video.mp4',
        top_comments: [{ text: 'nice', digg_count: 3, nickname: 'alice' }],
      },
    ]);
  });

  it('skips comment enrichment when with_comments is false', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockImplementation(async (_p, _method, url: string) => {
      if (url.includes('/aweme/v1/web/aweme/post/')) {
        return {
          aweme_list: [
            {
              aweme_id: '2',
              desc: 'plain video',
              video: { duration: 2000, play_addr: { url_list: ['https://example.com/plain.mp4'] } },
              statistics: { digg_count: 1 },
            },
          ],
        };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const rows = await command!.func!(page, {
      sec_uid: 'MS4w-test',
      limit: 3,
      with_comments: false,
      comment_limit: 5,
    });

    const calledComments = page.browserFetch.mock.calls.some((c) =>
      String(c[2]).includes('/aweme/v1/web/comment/list/'),
    );
    expect(calledComments).toBe(false);

    expect(rows).toEqual([
      {
        index: 1,
        aweme_id: '2',
        title: 'plain video',
        duration: 2,
        digg_count: 1,
        play_url: 'https://example.com/plain.mp4',
        top_comments: [],
      },
    ]);
  });

  it('throws EmptyResultError when the user videos API returns no rows', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockImplementation(async (_p, _method, url: string) => {
      if (url.includes('/aweme/v1/web/aweme/post/')) return { aweme_list: [] };
      throw new Error(`unexpected url ${url}`);
    });
    await expect(
      command!.func!(page, {
        sec_uid: 'MS4w-empty',
        limit: 3,
        with_comments: true,
        comment_limit: 5,
      }),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('surfaces comment enrichment failures instead of returning empty comments', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockImplementation(async (_p, _method, url: string) => {
      if (url.includes('/aweme/v1/web/aweme/post/')) {
        return {
          aweme_list: [
            {
              aweme_id: '3',
              desc: 'comment failure',
              video: { duration: 2000, play_addr: { url_list: ['https://example.com/fail.mp4'] } },
              statistics: { digg_count: 1 },
            },
          ],
        };
      }
      if (url.includes('/aweme/v1/web/comment/list/')) {
        throw new Error('comment API down');
      }
      throw new Error(`unexpected url ${url}`);
    });
    await expect(
      command!.func!(page, {
        sec_uid: 'MS4w-test',
        limit: 3,
        with_comments: true,
        comment_limit: 5,
      }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
