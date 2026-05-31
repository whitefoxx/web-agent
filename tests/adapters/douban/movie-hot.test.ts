/**
 * Port of opencli's clis/douban/movie-hot.test.js.
 *
 * opencli's test is metadata-only: it pins `command.columns` to the exact set
 * exposed by the chart page (and asserts director/region/quote are NOT among
 * them). That assertion ports verbatim against the bundled command object.
 *
 * The bundled adapter is a DOM scraper (page.goto → ensureDoubanReady →
 * page.evaluate(<extraction>) → rows). opencli never exercised func, but the
 * func paths are reachable through the fake page, so we additionally cover the
 * substantive behavior: the chart URL it navigates to, the rows it returns,
 * the EmptyResultError on no rows, and the AUTH_REQUIRED guard when the page
 * is blocked. The bundled file inlines its helpers (no exports), so no pure
 * helper is unit-testable in isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { CliError, EmptyResultError } from '../../../src/runtime/errors.js';
import { makeFakeDoubanPage } from '../_helpers/douban-page.js';

import '../../../marketplace/douban/movie-hot.js';

describe('douban movie-hot (marketplace)', () => {
  const command = findAdapter('douban', 'movie-hot');
  let page = makeFakeDoubanPage();

  beforeEach(() => {
    page = makeFakeDoubanPage();
  });

  // ── ported opencli assertion ──────────────────────────────────────────
  it('exposes only fields available from the chart page', () => {
    expect(command?.columns).toEqual(['rank', 'id', 'title', 'rating', 'votes', 'year', 'url']);
    expect(command?.columns).not.toContain('director');
    expect(command?.columns).not.toContain('region');
    expect(command?.columns).not.toContain('quote');
  });

  // ── reachable func behavior ───────────────────────────────────────────
  it('navigates to the chart page and returns the scraped rows', async () => {
    const rows = [
      {
        rank: 1,
        id: '1234567',
        title: '某电影',
        rating: 8.7,
        votes: 12345,
        year: '2023',
        url: 'https://movie.douban.com/subject/1234567/',
        cover: 'https://img.douban.com/x.jpg',
      },
    ];
    page.extract.mockResolvedValueOnce(rows);

    const result = await command!.func!(page, { limit: 20 });

    expect(page.goto).toHaveBeenCalledWith('https://movie.douban.com/chart');
    expect(result).toEqual(rows);
  });

  it('clamps the requested limit into the extraction script (1..50)', async () => {
    page.extract.mockResolvedValueOnce([
      { rank: 1, id: '1', title: 't', rating: 0, votes: 0, year: '', url: 'u', cover: '' },
    ]);
    await command!.func!(page, { limit: 999 });
    // The clamped limit is baked into the extraction script's `>= N break`.
    const script = page.extract.mock.calls[0][0] as string;
    expect(script).toContain('>= 50');
  });

  it('throws EmptyResultError when no chart rows are parsed', async () => {
    page.extract.mockResolvedValueOnce([]);
    await expect(command!.func!(page, { limit: 20 })).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('treats a non-array extraction result as empty', async () => {
    page.extract.mockResolvedValueOnce(null);
    await expect(command!.func!(page, { limit: 20 })).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('raises an AUTH_REQUIRED CliError when douban blocks the session', async () => {
    page.readyState = { blocked: true, title: '登录跳转', href: 'https://sec.douban.com/' };
    await expect(command!.func!(page, { limit: 20 })).rejects.toSatisfy(
      (err: unknown) => err instanceof CliError && (err as CliError).code === 'AUTH_REQUIRED',
    );
    // Blocked before any extraction runs.
    expect(page.extract).not.toHaveBeenCalled();
  });
});
