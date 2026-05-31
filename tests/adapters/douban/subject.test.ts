/**
 * Port of opencli's clis/douban/subject.test.js.
 *
 * opencli's test pins one piece of metadata: `navigateBefore === false`. That
 * ports verbatim against the bundled command object.
 *
 * The bundled adapter has substantive, reachable func behavior that opencli's
 * metadata-only test never exercised:
 *
 *   - normalizeDoubanSubjectId rejects non-numeric IDs with ArgumentError
 *     BEFORE any navigation (reachable purely through func with no page work).
 *   - movie path: goto movie URL → extract → returns the scraped object,
 *     wrapped in a single-element array.
 *   - book path: goto book URL → extract a RAW scrape → normalizeDoubanBookSubject
 *     reshapes it (parses #info text into authors/translators/publisher/ISBN/
 *     page count/etc., parses rating + rating count). That reshape runs in Node
 *     on the value the extraction script returns, so it is fully reachable and
 *     worth pinning. The bundled file inlines these helpers (no exports), so we
 *     cover them through func rather than in isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { ArgumentError, CliError } from '../../../src/runtime/errors.js';
import { makeFakeDoubanPage } from '../_helpers/douban-page.js';

import '../../../marketplace/douban/subject.js';

describe('douban subject (marketplace)', () => {
  const command = findAdapter('douban', 'subject');
  let page = makeFakeDoubanPage();

  beforeEach(() => {
    page = makeFakeDoubanPage();
  });

  // ── ported opencli assertion ──────────────────────────────────────────
  it('skips default pre-navigation because the adapter handles subject navigation itself', () => {
    expect(command).toBeDefined();
    expect(command?.navigateBefore).toBe(false);
  });

  // ── id validation (reachable before any navigation) ───────────────────
  it('rejects non-numeric subject ids with ArgumentError before navigating', async () => {
    for (const id of ['abc', '12a', '', 'https://movie.douban.com/subject/1/']) {
      await expect(command!.func!(page, { id, type: 'movie' })).rejects.toBeInstanceOf(
        ArgumentError,
      );
    }
    expect(page.goto).not.toHaveBeenCalled();
  });

  // ── movie path ────────────────────────────────────────────────────────
  it('navigates to the movie subject page and returns the scraped detail in an array', async () => {
    const detail = {
      id: '1234567',
      type: 'movie',
      title: '让子弹飞',
      originalTitle: '',
      year: '2010',
      rating: 8.9,
      ratingCount: 1300000,
      genres: '剧情,喜剧,动作',
      directors: '姜文',
      casts: ['姜文', '葛优', '周润发'],
      country: ['中国大陆', '中国香港'],
      duration: 132,
      summary: '北洋年间，南部中国。',
      url: 'https://movie.douban.com/subject/1234567/',
    };
    page.extract.mockResolvedValueOnce(detail);

    const result = await command!.func!(page, { id: '1234567', type: 'movie' });

    expect(page.goto).toHaveBeenCalledWith(
      'https://movie.douban.com/subject/1234567/',
      expect.objectContaining({ waitUntil: 'load' }),
    );
    expect(result).toEqual([detail]);
  });

  it('defaults to the movie path when no type is given', async () => {
    page.extract.mockResolvedValueOnce({ id: '99', type: 'movie', title: 'x', url: 'u' });
    await command!.func!(page, { id: '99' });
    expect(page.goto.mock.calls[0][0]).toBe('https://movie.douban.com/subject/99/');
  });

  // ── book path: normalizeDoubanBookSubject reshaping ───────────────────
  it('navigates to the book subject page and normalizes the scraped raw fields', async () => {
    const rawScrape = {
      id: '2345678',
      title: '三体',
      subtitle: '',
      originalTitle: '',
      infoText: [
        '作者: 刘慈欣',
        '出版社: 重庆出版社',
        '副标题: 地球往事三部曲之一',
        '出版年: 2008-1',
        '页数: 302',
        '定价: 23.00元',
        '装帧: 平装',
        '丛书: 中国科幻基石丛书',
        'ISBN: 9787536692930',
      ].join('\n'),
      rating: '8.8',
      ratingCount: '(545,210人评价)',
      summary: '文化大革命如火如荼地进行的同时...',
      cover: 'https://img.douban.com/cover.jpg',
      url: 'https://book.douban.com/subject/2345678/',
    };
    page.extract.mockResolvedValueOnce(rawScrape);

    const result = (await command!.func!(page, { id: '2345678', type: 'book' })) as Array<
      Record<string, unknown>
    >;

    expect(page.goto).toHaveBeenCalledWith(
      'https://book.douban.com/subject/2345678/',
      expect.objectContaining({ waitUntil: 'load' }),
    );
    const book = result[0];
    expect(book.id).toBe('2345678');
    expect(book.type).toBe('book');
    expect(book.title).toBe('三体');
    expect(book.subtitle).toBe('地球往事三部曲之一');
    expect(book.authors).toEqual(['刘慈欣']);
    expect(book.translators).toEqual([]);
    expect(book.publisher).toBe('重庆出版社');
    expect(book.publishDate).toBe('2008-1');
    expect(book.publishYear).toBe('2008');
    expect(book.pageCount).toBe(302);
    expect(book.binding).toBe('平装');
    expect(book.price).toBe('23.00元');
    expect(book.series).toBe('中国科幻基石丛书');
    expect(book.isbn13).toBe('9787536692930');
    expect(book.isbn10).toBe('');
    expect(book.rating).toBe(8.8);
    expect(book.ratingCount).toBe(545210);
    expect(book.cover).toBe('https://img.douban.com/cover.jpg');
    expect(book.url).toBe('https://book.douban.com/subject/2345678/');
  });

  it('splits multiple book authors/translators on the slash separator', async () => {
    page.extract.mockResolvedValueOnce({
      id: '777',
      title: '某书',
      infoText: ['作者: 甲 / 乙', '译者: 丙 / 丁', 'ISBN: 1234567890'].join('\n'),
      rating: '',
      ratingCount: '',
      summary: '',
      cover: '',
      url: 'https://book.douban.com/subject/777/',
    });
    const result = (await command!.func!(page, { id: '777', type: 'book' })) as Array<
      Record<string, unknown>
    >;
    expect(result[0].authors).toEqual(['甲', '乙']);
    expect(result[0].translators).toEqual(['丙', '丁']);
    // 10-digit ISBN populates isbn10, not isbn13.
    expect(result[0].isbn10).toBe('1234567890');
    expect(result[0].isbn13).toBe('');
    // Missing rating/count normalize to 0.
    expect(result[0].rating).toBe(0);
    expect(result[0].ratingCount).toBe(0);
  });

  it('rejects a book scrape whose normalized id is non-numeric', async () => {
    // normalizeDoubanBookSubject re-validates raw.id via normalizeDoubanSubjectId.
    page.extract.mockResolvedValueOnce({
      id: 'not-a-number',
      title: '坏书',
      infoText: '',
      rating: '',
      ratingCount: '',
      summary: '',
      cover: '',
      url: '',
    });
    await expect(command!.func!(page, { id: '888', type: 'book' })).rejects.toBeInstanceOf(
      ArgumentError,
    );
  });

  // ── auth guard ────────────────────────────────────────────────────────
  it('raises an AUTH_REQUIRED CliError when douban blocks the session', async () => {
    page.readyState = { blocked: true, title: '登录跳转', href: 'https://sec.douban.com/' };
    await expect(command!.func!(page, { id: '123', type: 'movie' })).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && (err as CliError).code === 'AUTH_REQUIRED',
    );
    expect(page.extract).not.toHaveBeenCalled();
  });
});
