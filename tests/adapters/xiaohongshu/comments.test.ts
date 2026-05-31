/**
 * Port of opencli's clis/xiaohongshu/comments.test.js.
 *
 * The bundled marketplace/xiaohongshu/comments.js re-exports the pure helper
 * `parseXhsLikeCountText` and `buildCommentsExtractJs`, so those are tested
 * directly. The single opencli test that evals `buildCommentsExtractJs`
 * against a real `jsdom` DOM ("extracts shortform like counts from the shared
 * xiaohongshu/rednote DOM script") is SKIPPED here: it requires the `jsdom`
 * package, which is not a dependency of this repo and may not be added (test
 * dir only). Its behavioral core (shortform like-count parsing) is still fully
 * covered by the `parseXhsLikeCountText` block below, which is the exact
 * function the DOM script uses for `likes`.
 *
 * All `xiaohongshu comments` func tests are ported faithfully via the page
 * mock — opencli's createPageMock(evaluateResult) resolves a single canned
 * value for the one `page.evaluate(buildCommentsExtractJs(...))` call.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeXiaohongshuPage } from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/comments.js';
import {
  buildCommentsExtractJs,
  parseXhsLikeCountText,
} from '../../../marketplace/xiaohongshu/comments.js';

describe('parseXhsLikeCountText', () => {
  it('parses exact integer and shortform like counts', () => {
    expect(parseXhsLikeCountText('0')).toBe(0);
    expect(parseXhsLikeCountText('42')).toBe(42);
    expect(parseXhsLikeCountText('1,234')).toBe(1234);
    expect(parseXhsLikeCountText('1，234+')).toBe(1234);
    expect(parseXhsLikeCountText('2.1w')).toBe(21000);
    expect(parseXhsLikeCountText('1.5万')).toBe(15000);
    expect(parseXhsLikeCountText('1.2k')).toBe(1200);
    expect(parseXhsLikeCountText('3千')).toBe(3000);
    expect(parseXhsLikeCountText(' 2.1 w + ')).toBe(21000);
  });

  it('returns 0 for unknown shapes without overparsing arbitrary text', () => {
    for (const raw of ['', null, undefined, '赞', 'likes 2.1w', '2w人', '1,23', '1.2.3k', '.', '1.5']) {
      expect(parseXhsLikeCountText(raw)).toBe(0);
    }
  });
});

describe('xiaohongshu/comments (marketplace)', () => {
  const command = findAdapter('xiaohongshu', 'comments');

  let page = makeFakeXiaohongshuPage();
  beforeEach(() => {
    page = makeFakeXiaohongshuPage();
  });

  it('returns ranked comment rows for signed full URLs', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      results: [
        { author: 'Alice', text: 'Great note!', likes: 10, time: '2024-01-01', is_reply: false, reply_to: '' },
        { author: 'Bob', text: 'Very helpful', likes: 0, time: '2024-01-02', is_reply: false, reply_to: '' },
      ],
    });
    const signedUrl =
      'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search';
    const result = (await command!.func!(page, { 'note-id': signedUrl, limit: 5 })) as Array<
      Record<string, unknown>
    >;
    expect(page.goto.mock.calls[0][0]).toBe(signedUrl);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ rank: 1, author: 'Alice', text: 'Great note!', likes: 10 });
    expect(result[1]).toMatchObject({ rank: 2, author: 'Bob', text: 'Very helpful', likes: 0 });
  });

  it('rejects bare note IDs before browser navigation', async () => {
    page.evaluate.mockResolvedValue({ loginWall: false, results: [] });
    await expect(
      command!.func!(page, { 'note-id': '69aadbcb000000002202f131', limit: 5 }),
    ).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('signed URL'),
      help: expect.stringContaining('xsec_token'),
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('preserves signed /explore/ URL as-is for navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      results: [{ author: 'Alice', text: 'Nice', likes: 1, time: '2024-01-01', is_reply: false, reply_to: '' }],
    });
    await command!.func!(page, {
      'note-id':
        'https://www.xiaohongshu.com/explore/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search',
      limit: 5,
    });
    expect(page.goto.mock.calls[0][0]).toContain('/explore/69aadbcb000000002202f131?xsec_token=abc');
  });

  it('preserves full search_result URL with xsec_token for navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      results: [{ author: 'Alice', text: 'Nice', likes: 1, time: '2024-01-01', is_reply: false, reply_to: '' }],
    });
    const fullUrl =
      'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search';
    await command!.func!(page, { 'note-id': fullUrl, limit: 5 });
    expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
  });

  it('preserves signed /user/profile/<user>/<note> URLs for navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      results: [{ author: 'Alice', text: 'Nice', likes: 1, time: '2024-01-01', is_reply: false, reply_to: '' }],
    });
    const fullUrl =
      'https://www.xiaohongshu.com/user/profile/user123/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_user';
    await command!.func!(page, { 'note-id': fullUrl, limit: 5 });
    expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
  });

  it('throws AuthRequiredError when login wall is detected', async () => {
    page.evaluate.mockResolvedValue({ loginWall: true, results: [] });
    await expect(
      command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
        limit: 5,
      }),
    ).rejects.toThrow('Note comments require login');
  });

  it('throws SECURITY_BLOCK with retry guidance when a full URL comments page is blocked', async () => {
    page.evaluate.mockResolvedValue({
      pageUrl: 'https://www.xiaohongshu.com/website-login/error?error_code=300031',
      securityBlock: true,
      loginWall: false,
      results: [],
    });
    await expect(
      command!.func!(page, {
        'note-id':
          'https://www.xiaohongshu.com/search_result/69aadbcb000000002202f131?xsec_token=abc&xsec_source=pc_search',
        limit: 5,
      }),
    ).rejects.toMatchObject({
      code: 'SECURITY_BLOCK',
      help: expect.stringContaining('Try again later'),
    });
  });

  it('returns empty array when no comments are found', async () => {
    page.evaluate.mockResolvedValue({ loginWall: false, results: [] });
    await expect(
      command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it('uses condition-based comment scrolling instead of a fixed blind loop', async () => {
    page.evaluate.mockResolvedValue({ loginWall: false, results: [] });
    await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
      limit: 5,
    });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain("const beforeCount = scroller.querySelectorAll('.parent-comment').length");
    expect(script).toContain("const afterCount = scroller.querySelectorAll('.parent-comment').length");
    expect(script).toContain('if (afterCount <= beforeCount) break');
  });

  // Behavioral equivalent of opencli's jsdom "extracts shortform like counts
  // from the shared DOM script" test — the DOM script delegates `likes` parsing
  // entirely to parseXhsLikeCountText, asserted directly here without jsdom.
  it('shortform like-count parsing used by the DOM script matches the rednote behavior', () => {
    expect(parseXhsLikeCountText('2.1w')).toBe(21000);
    expect(parseXhsLikeCountText('likes 2.1w')).toBe(0);
    // The shared extract script bakes parseXhsLikeCountText's source in verbatim.
    expect(buildCommentsExtractJs(false)).toContain(parseXhsLikeCountText.toString());
  });

  it('respects the limit for top-level comments', async () => {
    const manyComments = Array.from({ length: 10 }, (_, i) => ({
      author: `User${i}`,
      text: `Comment ${i}`,
      likes: i,
      time: '2024-01-01',
      is_reply: false,
      reply_to: '',
    }));
    page.evaluate.mockResolvedValue({ loginWall: false, results: manyComments });
    const result = (await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
      limit: 3,
    })) as Array<{ rank: number }>;
    expect(result).toHaveLength(3);
    expect(result[0].rank).toBe(1);
    expect(result[2].rank).toBe(3);
  });

  it('clamps invalid negative limits to a safe minimum', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      results: [
        { author: 'Alice', text: 'Great note!', likes: 10, time: '2024-01-01', is_reply: false, reply_to: '' },
        { author: 'Bob', text: 'Very helpful', likes: 0, time: '2024-01-02', is_reply: false, reply_to: '' },
      ],
    });
    const result = (await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
      limit: -3,
    })) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rank: 1, author: 'Alice' });
  });

  describe('--with-replies', () => {
    it('includes reply rows with is_reply=true and reply_to set', async () => {
      page.evaluate.mockResolvedValue({
        loginWall: false,
        results: [
          { author: 'Alice', text: 'Main comment', likes: 10, time: '03-25', is_reply: false, reply_to: '' },
          { author: 'Bob', text: 'Reply to Alice', likes: 3, time: '03-25', is_reply: true, reply_to: 'Alice' },
          { author: 'Carol', text: 'Another top', likes: 5, time: '03-26', is_reply: false, reply_to: '' },
        ],
      });
      const result = (await command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
        limit: 50,
        'with-replies': true,
      })) as Array<Record<string, unknown>>;
      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ author: 'Alice', is_reply: false, reply_to: '' });
      expect(result[1]).toMatchObject({ author: 'Bob', is_reply: true, reply_to: 'Alice' });
      expect(result[2]).toMatchObject({ author: 'Carol', is_reply: false, reply_to: '' });
      const script = page.evaluate.mock.calls[0][0];
      expect(script).toContain('共\\d+条回复');
      expect(script).toContain('el.click()');
    });

    it('limits by top-level count, keeping attached replies', async () => {
      page.evaluate.mockResolvedValue({
        loginWall: false,
        results: [
          { author: 'A', text: 'Top 1', likes: 0, time: '', is_reply: false, reply_to: '' },
          { author: 'A1', text: 'Reply 1', likes: 0, time: '', is_reply: true, reply_to: 'A' },
          { author: 'A2', text: 'Reply 2', likes: 0, time: '', is_reply: true, reply_to: 'A' },
          { author: 'B', text: 'Top 2', likes: 0, time: '', is_reply: false, reply_to: '' },
          { author: 'C', text: 'Top 3', likes: 0, time: '', is_reply: false, reply_to: '' },
        ],
      });
      const result = (await command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
        limit: 2,
        'with-replies': true,
      })) as Array<{ author: string }>;
      expect(result).toHaveLength(4);
      expect(result.map((r) => r.author)).toEqual(['A', 'A1', 'A2', 'B']);
    });
  });
});
