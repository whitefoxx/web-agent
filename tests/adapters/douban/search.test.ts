/**
 * Port of opencli's clis/douban/search.test.js.
 *
 * opencli's test pins one piece of metadata: `navigateBefore === false`
 * (the adapter navigates itself). That ports verbatim against the bundled
 * command object.
 *
 * The bundled adapter is a DOM scraper: it builds a search URL, page.goto's
 * it, runs ensureDoubanReady, waits for a selector, then page.evaluate's an
 * extraction script and returns its rows (or [] when the script yields a
 * non-array). opencli never drove func, but those paths are reachable through
 * the fake page, so we additionally cover the substantive behavior: the exact
 * search URL built per type (movie / book→cat=1001 / music), returning the
 * scraped rows, and the empty-result-as-[] contract. The bundled file inlines
 * inferDoubanSearchResultType inside the in-page script (not reachable from
 * Node), so its tv-show inference is not unit-testable here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CliError } from '@base/runtime/errors.js';
import { makeFakeDoubanPage } from '../_helpers/douban-page.js';

import '../../../marketplace/douban/search.js';

describe('douban search (marketplace)', () => {
  const command = findAdapter('douban', 'search');
  let page = makeFakeDoubanPage();

  beforeEach(() => {
    page = makeFakeDoubanPage();
  });

  // ── ported opencli assertion ──────────────────────────────────────────
  it('skips default pre-navigation because the adapter handles navigation itself', () => {
    expect(command).toBeDefined();
    expect(command?.navigateBefore).toBe(false);
  });

  // ── reachable func behavior ───────────────────────────────────────────
  it('builds the movie search URL and returns the scraped rows', async () => {
    const rows = [
      {
        rank: 1,
        id: '111',
        type: 'movie',
        title: '电影标题',
        rating: 8.1,
        abstract: '简介',
        url: 'https://movie.douban.com/subject/111/',
        cover: '',
      },
    ];
    page.extract.mockResolvedValueOnce(rows);

    const result = await command!.func!(page, { type: 'movie', keyword: '让子弹飞', limit: 20 });

    expect(result).toEqual(rows);
    const gotoUrl = page.goto.mock.calls[0][0] as string;
    const parsed = new URL(gotoUrl);
    expect(parsed.origin).toBe('https://search.douban.com');
    expect(parsed.pathname).toBe('/movie/subject_search');
    expect(parsed.searchParams.get('search_text')).toBe('让子弹飞');
    // movie searches do NOT pin a book category.
    expect(parsed.searchParams.get('cat')).toBeNull();
  });

  it('adds cat=1001 to book searches', async () => {
    page.extract.mockResolvedValueOnce([]);
    await command!.func!(page, { type: 'book', keyword: '三体', limit: 20 });

    const parsed = new URL(page.goto.mock.calls[0][0] as string);
    expect(parsed.pathname).toBe('/book/subject_search');
    expect(parsed.searchParams.get('search_text')).toBe('三体');
    expect(parsed.searchParams.get('cat')).toBe('1001');
  });

  it('builds the music search URL without a book category', async () => {
    page.extract.mockResolvedValueOnce([]);
    await command!.func!(page, { type: 'music', keyword: 'beatles', limit: 20 });

    const parsed = new URL(page.goto.mock.calls[0][0] as string);
    expect(parsed.pathname).toBe('/music/subject_search');
    expect(parsed.searchParams.get('cat')).toBeNull();
  });

  it('returns [] when the extraction script yields a non-array', async () => {
    page.extract.mockResolvedValueOnce(null);
    await expect(command!.func!(page, { type: 'movie', keyword: 'x', limit: 20 })).resolves.toEqual(
      [],
    );
  });

  it('propagates the AUTH_REQUIRED CliError when douban blocks the session', async () => {
    page.readyState = { blocked: true, title: '异常请求', href: 'https://sec.douban.com/' };
    await expect(
      command!.func!(page, { type: 'movie', keyword: 'x', limit: 20 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && (err as CliError).code === 'AUTH_REQUIRED',
    );
    expect(page.extract).not.toHaveBeenCalled();
  });
});
