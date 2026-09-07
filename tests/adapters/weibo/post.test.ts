/**
 * weibo/post — image-URL extraction (web enhancement over opencli).
 *
 * opencli's post.test.js doesn't exist for the bundled set; more importantly,
 * the weibo fake-page helper returns canned data and never RUNS the in-page
 * fetch script, so it can't verify the pic extraction we added. This test
 * executes the adapter's real `page.evaluate(<fetch script>)` against a stubbed
 * `fetch` returning a canned /ajax/statuses/show payload, so the actual
 * collectPics logic (pic_ids order + pic_infos size-variant preference, longText
 * fallback, retweet pics) is exercised end-to-end.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';

import '../../../marketplace/weibo/post.js';

/** Build a fake page whose evaluate ACTUALLY runs the in-page script with a
 * stubbed fetch that serves `showJson` for the show endpoint. */
function makeExecutingPage(showJson: unknown, longtextJson: unknown = { data: {} }) {
  const fetchStub = async (url: string) => {
    if (url.includes('/ajax/statuses/show')) return { ok: true, json: async () => showJson };
    if (url.includes('/ajax/statuses/longtext')) return { ok: true, json: async () => longtextJson };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script: string) => {
      // The func already interpolated the id, so `script` is the final IIFE.
      const fn = new Function('fetch', `return (${script})`);
      return fn(fetchStub);
    }),
  };
}

const command = findAdapter('weibo', 'post');

function rowsToObj(rows: unknown): Record<string, unknown> {
  return Object.fromEntries((rows as Array<{ field: string; value: unknown }>).map((r) => [r.field, r.value]));
}

describe('weibo/post image URLs', () => {
  it('adds a newline-joined pics field in pic_ids order, preferring the largest variant', async () => {
    const showJson = {
      ok: 1,
      idstr: '5304775764609288',
      id: 5304775764609288,
      mblogid: 'R20eQjl5m',
      user: { id: 6624782994, screen_name: '圈内容嬷嬷' },
      text_raw: '天涯神帖',
      created_at: 'Sun May 31 23:16:03 +0800 2026',
      source: '所愿皆成真',
      reposts_count: 1392,
      comments_count: 171,
      attitudes_count: 3852,
      pic_num: 3,
      isLongText: false,
      pic_ids: ['pidA', 'pidB', 'pidC'],
      pic_infos: {
        // largest present → used
        pidA: { largest: { url: 'https://wx4.sinaimg.cn/large/pidA.jpg' }, original: { url: 'https://x/orj1080/pidA.jpg' } },
        // no largest → falls to original
        pidB: { original: { url: 'https://wx2.sinaimg.cn/orj1080/pidB.jpg' } },
        // only thumbnail → used as last resort
        pidC: { thumbnail: { url: 'https://wx1.sinaimg.cn/wap180/pidC.jpg' } },
      },
    };

    const page = makeExecutingPage(showJson);
    const rows = await command!.func!(page, { id: '5304775764609288' });
    const obj = rowsToObj(rows);

    expect(obj.pics).toEqual([
      'https://wx4.sinaimg.cn/large/pidA.jpg',
      'https://wx2.sinaimg.cn/orj1080/pidB.jpg',
      'https://wx1.sinaimg.cn/wap180/pidC.jpg',
    ]);
    expect(obj.pic_count).toBe('3');
    expect(obj.author).toBe('圈内容嬷嬷');
  });

  it('falls back to longText.pic_infos / pic_ids when the top level lacks them', async () => {
    const showJson = {
      ok: 1,
      idstr: '1',
      id: 1,
      mblogid: 'm1',
      user: { id: 9, screen_name: 'u' },
      text_raw: 't',
      attitudes_count: 0,
      pic_num: 1,
      isLongText: false,
      longText: {
        pic_ids: ['lp1'],
        pic_infos: { lp1: { original: { url: 'https://x/orj1080/lp1.jpg' } } },
      },
    };
    const page = makeExecutingPage(showJson);
    const obj = rowsToObj(await command!.func!(page, { id: '1' }));
    expect(obj.pics).toEqual(['https://x/orj1080/lp1.jpg']);
  });

  it('omits pics for a text-only post and includes retweeted_pics for a retweet', async () => {
    const textOnly = {
      ok: 1, idstr: '2', id: 2, mblogid: 'm2', user: { id: 1, screen_name: 'a' },
      text_raw: 'hi', attitudes_count: 0, pic_num: 0, isLongText: false,
    };
    const textRows = rowsToObj(await command!.func!(makeExecutingPage(textOnly), { id: '2' }));
    expect(textRows.pics).toBeUndefined();

    const retweet = {
      ok: 1, idstr: '3', id: 3, mblogid: 'm3', user: { id: 1, screen_name: 'a' },
      text_raw: 'rt', attitudes_count: 0, pic_num: 0, isLongText: false,
      retweeted_status: {
        user: { screen_name: 'orig' },
        text_raw: 'original',
        pic_ids: ['rp1'],
        pic_infos: { rp1: { largest: { url: 'https://x/large/rp1.jpg' } } },
      },
    };
    const rtRows = rowsToObj(await command!.func!(makeExecutingPage(retweet), { id: '3' }));
    expect(rtRows.pics).toBeUndefined();
    expect(rtRows.retweeted_from).toBe('orig');
    expect(rtRows.retweeted_pics).toEqual(['https://x/large/rp1.jpg']);
  });
});
