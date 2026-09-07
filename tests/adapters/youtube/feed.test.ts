/**
 * Port of opencli's clis/youtube/feed.test.js.
 *
 * Seam: feed builds a self-contained async-IIFE script that reads
 * `window.ytInitialData` + `window.ytcfg` and, when the first page is below the
 * limit, paginates via `fetch('/youtubei/v1/browse...')`. opencli's `makePage`
 * evals that script with those globals mocked; `makeFeedFetchPage` reproduces
 * the same seam. The substantive assertions (goto target, wait(3), single
 * continuation fetch, and the merged first-page + continuation rows) are
 * preserved verbatim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFeedFetchPage } from '../_helpers/youtube-page.js';

import '../../../marketplace/youtube/feed.js';

const initialData = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              richGridRenderer: {
                contents: [
                  {
                    richItemRenderer: {
                      content: {
                        videoRenderer: {
                          videoId: 'first-video',
                          title: { runs: [{ text: 'First video' }] },
                          ownerText: { runs: [{ text: 'First channel' }] },
                          viewCountText: { simpleText: '1K views' },
                          lengthText: { simpleText: '10:00' },
                          publishedTimeText: { simpleText: '1 day ago' },
                        },
                      },
                    },
                  },
                  {
                    continuationItemRenderer: {
                      continuationEndpoint: {
                        continuationCommand: {
                          token: 'next-token',
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const continuationData = {
  onResponseReceivedActions: [
    {
      appendContinuationItemsAction: {
        continuationItems: [
          {
            richItemRenderer: {
              content: {
                videoRenderer: {
                  videoId: 'second-video',
                  title: { runs: [{ text: 'Second video' }] },
                  ownerText: { runs: [{ text: 'Second channel' }] },
                  viewCountText: { simpleText: '2K views' },
                  lengthText: { simpleText: '11:00' },
                  publishedTimeText: { simpleText: '2 days ago' },
                },
              },
            },
          },
        ],
      },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('youtube feed (marketplace)', () => {
  const command = findAdapter('youtube', 'feed');

  it('uses continuation results when the first page is below limit', async () => {
    const page = makeFeedFetchPage({ initialData, continuationData });

    const rows = await command!.func!(page, { limit: 2 });

    expect(page.goto).toHaveBeenCalledWith('https://www.youtube.com');
    expect(page.wait).toHaveBeenCalledWith(3);
    expect(page.__fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      expect.objectContaining({
        rank: 1,
        title: 'First video',
        video_id: 'first-video',
        url: 'https://www.youtube.com/watch?v=first-video',
      }),
      expect.objectContaining({
        rank: 2,
        title: 'Second video',
        video_id: 'second-video',
        url: 'https://www.youtube.com/watch?v=second-video',
      }),
    ]);
  });
});
