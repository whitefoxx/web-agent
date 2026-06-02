/**
 * Port of opencli's clis/linkedin/search.test.js.
 * Pure-helper assertions via __test__ + func tests with inline fake pages.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { ArgumentError, AuthRequiredError } from '../../../src/runtime/errors.js';
import { withSessionScratch } from '../_helpers/session-scratch';
import { __test__ } from '../../../marketplace/linkedin/search.js';

const {
  parseCsvArg,
  parseIntegerArg,
  mapFilterValues,
  decodeLinkedinRedirect,
  looksLinkedInAuthWallText,
  enrichJobDetails,
  EXPERIENCE_LEVELS,
  JOB_TYPES,
  DATE_POSTED,
  REMOTE_TYPES,
} = __test__ as any;

const getSearchCommand = () => findAdapter('linkedin', 'search');

describe('linkedin parseCsvArg', () => {
  it('returns empty array for empty / null / undefined', () => {
    expect(parseCsvArg(undefined)).toEqual([]);
    expect(parseCsvArg(null)).toEqual([]);
    expect(parseCsvArg('')).toEqual([]);
  });

  it('splits and trims comma-separated values', () => {
    expect(parseCsvArg('full-time, contract')).toEqual(['full-time', 'contract']);
    expect(parseCsvArg(' a , b , , c ')).toEqual(['a', 'b', 'c']);
  });
});

describe('linkedin mapFilterValues', () => {
  it('maps known values to upstream codes and dedupes', () => {
    expect(mapFilterValues('full-time, contract, full', JOB_TYPES, 'job_type')).toEqual(['F', 'C']);
    expect(mapFilterValues('remote, hybrid', REMOTE_TYPES, 'remote')).toEqual(['2', '3']);
  });

  it('throws ArgumentError on unknown filter values (no silent drop)', () => {
    expect(() => mapFilterValues('martian', JOB_TYPES, 'job_type')).toThrow(ArgumentError);
    expect(() => mapFilterValues('full-time, ufo', JOB_TYPES, 'job_type')).toThrow(ArgumentError);
  });

  it('returns empty array for empty input', () => {
    expect(mapFilterValues('', EXPERIENCE_LEVELS, 'experience_level')).toEqual([]);
    expect(mapFilterValues(undefined, DATE_POSTED, 'date_posted')).toEqual([]);
  });
});

describe('linkedin argument validation', () => {
  it('rejects --limit outside 1..100 instead of silently clamping', () => {
    expect(() => parseIntegerArg(0, '--limit', 10, 1, 100)).toThrow(ArgumentError);
    expect(() => parseIntegerArg(101, '--limit', 10, 1, 100)).toThrow(ArgumentError);
    expect(() => parseIntegerArg('10.5', '--limit', 10, 1, 100)).toThrow(ArgumentError);
  });

  it('rejects negative --start instead of silently clamping to zero', () => {
    expect(() => parseIntegerArg(-1, '--start', 0, 0)).toThrow(ArgumentError);
    expect(parseIntegerArg(undefined, '--start', 0, 0)).toBe(0);
    expect(parseIntegerArg('25', '--start', 0, 0)).toBe(25);
  });

  it('validates command args before browser navigation', async () => {
    const command = getSearchCommand();
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn() };

    await expect(command!.func!(page, { query: 'engineer', limit: 0 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    await expect(command!.func!(page, { query: 'engineer', start: -1 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe('linkedin auth wall detection', () => {
  it('recognizes login/authwall signals', () => {
    expect(
      looksLinkedInAuthWallText('https://www.linkedin.com/authwall?trk=guest Sign in to continue'),
    ).toBe(true);
    expect(looksLinkedInAuthWallText('LinkedIn Login, Sign in')).toBe(true);
    expect(looksLinkedInAuthWallText('About the job Senior infrastructure engineer')).toBe(false);
  });

  it('throws AuthRequiredError when search lands on a login wall', async () => {
    const command = getSearchCommand();
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(true),
    };

    await expect(command!.func!(page, { query: 'engineer', limit: 5 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });
});

describe('linkedin decodeLinkedinRedirect', () => {
  it('extracts the underlying url from a /redir/redirect/ wrapper', () => {
    const target = 'https://example.com/jobs/apply?id=42';
    const wrapped = `https://www.linkedin.com/redir/redirect/?url=${encodeURIComponent(
      target,
    )}&source=jobs`;
    expect(decodeLinkedinRedirect(wrapped)).toBe(target);
  });

  it('returns the input unchanged for non-redirect urls', () => {
    const direct = 'https://example.com/jobs/42/';
    expect(decodeLinkedinRedirect(direct)).toBe(direct);
  });

  it('returns empty string for falsy input', () => {
    expect(decodeLinkedinRedirect('')).toBe('');
    expect(decodeLinkedinRedirect(null)).toBe('');
  });
});

describe('linkedin enrichJobDetails (silent failure fix)', () => {
  function makeFakePage({ evaluateResults = [], gotoFails = [], evaluateFails = [] }: any = {}) {
    let evalCall = 0;
    let gotoCall = 0;
    return {
      goto: vi.fn(async () => {
        if (gotoFails[gotoCall++]) {
          throw new Error(gotoFails[gotoCall - 1]);
        }
      }),
      wait: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => {
        const idx = evalCall++;
        if (evaluateFails[idx]) throw new Error(evaluateFails[idx]);
        return evaluateResults[idx];
      }),
    };
  }

  it('surfaces detail_error="no url" when row has no URL (instead of silent empty string)', async () => {
    const page = makeFakePage();
    const out = await enrichJobDetails(page, [{ rank: 1, title: 'No URL Job', company: 'X', url: '' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      description: null,
      apply_url: null,
      detail_error: 'no url',
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('surfaces detail_error="fetch failed: ..." when goto throws (no silent swallow)', async () => {
    const page = makeFakePage({ gotoFails: ['network down'] });
    const out = await enrichJobDetails(page, [
      { rank: 1, title: 'Fetch Fail', company: 'X', url: 'https://www.linkedin.com/jobs/view/1' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBeNull();
    expect(out[0].apply_url).toBeNull();
    expect(out[0].detail_error).toMatch(/^fetch failed: .*network down/);
  });

  it('surfaces detail_error="missing description" on empty description (signals upstream gap, not crash)', async () => {
    const page = makeFakePage({
      evaluateResults: [false, undefined, { description: '', applyUrl: '' }],
    });
    const out = await enrichJobDetails(page, [
      { rank: 1, title: 'Empty Desc', company: 'X', url: 'https://www.linkedin.com/jobs/view/2' },
    ]);
    expect(out[0].description).toBeNull();
    expect(out[0].apply_url).toBeNull();
    expect(out[0].detail_error).toBe('missing description');
  });

  it('surfaces detail_error=null on a fully successful enrichment', async () => {
    const page = makeFakePage({
      evaluateResults: [
        false,
        undefined,
        { description: '  An interesting role  ', applyUrl: 'https://example.com/apply' },
      ],
    });
    const out = await enrichJobDetails(page, [
      { rank: 1, title: 'OK', company: 'X', url: 'https://www.linkedin.com/jobs/view/3' },
    ]);
    expect(out[0]).toMatchObject({
      description: 'An interesting role',
      apply_url: 'https://example.com/apply',
      detail_error: null,
    });
  });

  it('processes multiple rows with mixed outcomes without aborting the batch', async () => {
    const page = makeFakePage({
      evaluateResults: [
        false,
        undefined,
        { description: 'Good', applyUrl: 'https://a.example/' },
        false,
        undefined,
        { description: 'Also good', applyUrl: 'https://b.example/' },
      ],
    });
    const out = await enrichJobDetails(page, [
      { rank: 1, title: 'A', company: 'X', url: 'https://www.linkedin.com/jobs/view/10' },
      { rank: 2, title: 'B', company: 'X', url: '' },
      { rank: 3, title: 'C', company: 'X', url: 'https://www.linkedin.com/jobs/view/30' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0].detail_error).toBeNull();
    expect(out[1].detail_error).toBe('no url');
    expect(out[2].detail_error).toBeNull();
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  it('throws AuthRequiredError on detail auth wall instead of burying it in detail_error', async () => {
    const page = makeFakePage({ evaluateResults: [true] });

    await expect(
      enrichJobDetails(page, [
        { rank: 1, title: 'Needs Auth', company: 'X', url: 'https://www.linkedin.com/jobs/view/4' },
      ]),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('linkedin --details trampoline state machine (func, end-to-end)', () => {
  // Build a voyager API element so fetchJobCards extracts { title, url, ... }.
  const voyagerCard = (jobId: string, title: string) => ({
    jobCardUnion: {
      jobPostingCard: {
        jobPostingUrn: `urn:li:fsd_jobPosting:${jobId}`,
        jobPostingTitle: title,
        primaryDescription: { text: 'Acme Corp' },
        secondaryDescription: { text: 'Remote' },
        tertiaryDescription: { text: '' },
        footerItems: [],
      },
    },
  });

  // A fake page whose page.evaluate routes by script content to the right
  // canned scrape result, wrapped in withSessionScratch so the state machine's
  // setItem/getItem/removeItem scripts hit a real in-memory store (mirroring the
  // same-origin tab's sessionStorage surviving a re-inject). page.goto is a
  // no-op, so the URL-driven loop runs LINEARLY in one call.
  function makeDetailsPage({
    cards,
    details, // map of "About the job" scrape results keyed by job id (from url)
    blockStorage, // simulate a tab where sessionStorage is unavailable
  }: {
    cards: any[];
    details: Record<string, { description: string; applyUrl: string }>;
    blockStorage?: boolean;
  }) {
    const gotoUrls: string[] = [];
    const page: any = {
      getCurrentUrl: vi.fn().mockResolvedValue(''), // empty → enter fresh-search stage
      getCookies: vi.fn().mockResolvedValue([{ name: 'JSESSIONID', value: '"ajax:123"' }]),
      goto: vi.fn(async (url: string) => {
        gotoUrls.push(url);
      }),
      wait: vi.fn(async () => undefined),
    };
    // Inner scrape: everything that is NOT a sessionStorage script.
    const scrape = (script: string): unknown => {
      // auth probe → not an auth wall
      if (script.includes('looksLinkedInAuthWallText')) return false;
      // voyager job-cards fetch → return the canned elements
      if (script.includes('voyagerJobsDashJobCards') || script.includes('csrf-token')) {
        return { elements: cards };
      }
      // "Show more" expand click → no meaningful return
      if (script.includes('btn.click()')) return undefined;
      // detail extraction → return per-job description keyed by the job id in the
      // currently-loaded url (the most recent goto).
      if (script.includes('applyLink')) {
        const here = gotoUrls[gotoUrls.length - 1] || '';
        const id = (here.match(/jobs\/view\/(\d+)/) || [])[1] || '';
        return details[id] ?? { description: '', applyUrl: '' };
      }
      return undefined;
    };
    if (blockStorage) {
      // Mirror the adapter's guarded scratch scripts on a tab where
      // sessionStorage throws: setItem → false, getItem → null, removeItem →
      // false. Real scrape scripts still flow through `scrape`.
      page.evaluate = vi.fn(async (script: string) => {
        const s = String(script);
        if (/sessionStorage\.setItem/.test(s)) return false;
        if (/sessionStorage\.getItem/.test(s)) return null;
        if (/sessionStorage\.removeItem/.test(s)) return false;
        return scrape(s);
      });
    } else {
      page.evaluate = withSessionScratch((script: string) => scrape(String(script)));
    }
    return { page, gotoUrls };
  }

  it('enriches every job across navigations and returns the merged list (no list re-fetch per job)', async () => {
    const command = getSearchCommand();
    const { page, gotoUrls } = makeDetailsPage({
      cards: [voyagerCard('10', 'Engineer A'), voyagerCard('20', 'Engineer B')],
      details: {
        '10': { description: '  Build things  ', applyUrl: 'https://acme.example/apply/10' },
        '20': { description: 'Ship things', applyUrl: 'https://acme.example/apply/20' },
      },
    });

    const out: any[] = await command!.func!(page, { query: 'engineer', limit: 2, details: true });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      rank: 1,
      title: 'Engineer A',
      description: 'Build things',
      apply_url: 'https://acme.example/apply/10',
      detail_error: null,
    });
    expect(out[1]).toMatchObject({
      rank: 2,
      title: 'Engineer B',
      description: 'Ship things',
      apply_url: 'https://acme.example/apply/20',
      detail_error: null,
    });
    // The search-results page is fetched once; each job is visited exactly once.
    // Crucially the voyager list is NOT re-fetched per job (the list is recovered
    // from the stash on each replay, not re-derived from a fresh search).
    const searchGotos = gotoUrls.filter((u) => /\/jobs\/search/.test(u));
    const jobGotos = gotoUrls.filter((u) => /\/jobs\/view\//.test(u));
    expect(searchGotos).toHaveLength(1);
    expect(jobGotos).toEqual([
      'https://www.linkedin.com/jobs/view/10',
      'https://www.linkedin.com/jobs/view/20',
    ]);
  });

  it('keeps per-row detail_error semantics: no-url rows and missing-description rows', async () => {
    const command = getSearchCommand();
    // Card with no resolvable id → url:'' (no-url row); plus a normal one whose
    // detail page returns an empty description (missing description).
    const noUrlCard = {
      jobCardUnion: {
        jobPostingCard: { jobPostingTitle: 'No URL Job', primaryDescription: { text: 'Acme' } },
      },
    };
    const { page } = makeDetailsPage({
      cards: [noUrlCard, voyagerCard('30', 'Empty Desc Job')],
      details: { '30': { description: '', applyUrl: '' } },
    });

    const out: any[] = await command!.func!(page, { query: 'engineer', limit: 2, details: true });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'No URL Job', detail_error: 'no url', description: null });
    expect(out[1]).toMatchObject({
      title: 'Empty Desc Job',
      detail_error: 'missing description',
      description: null,
    });
  });

  it('degrades (never ping-pongs) when the tab blocks sessionStorage', async () => {
    const command = getSearchCommand();
    // blockStorage → the very first setItem write is dropped (and read-back is
    // null), so the stash can never survive a re-inject. The SM must degrade
    // rather than navigate (otherwise a re-inject would find no stash, fall
    // through to a fresh search, re-seed, and navigate again — forever).
    const { page, gotoUrls } = makeDetailsPage({
      cards: [voyagerCard('40', 'Engineer A'), voyagerCard('50', 'Engineer B')],
      details: {
        '40': { description: 'Build', applyUrl: 'https://x/apply/40' },
        '50': { description: 'Ship', applyUrl: 'https://x/apply/50' },
      },
      blockStorage: true,
    });

    const out: any[] = await command!.func!(page, { query: 'engineer', limit: 2, details: true });

    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row.description).toBeNull();
      expect(row.apply_url).toBeNull();
      expect(row.detail_error).toBe('details unavailable for in-page execution');
    }
    // The key safety property: it did NOT navigate to any job page (no ping-pong).
    expect(gotoUrls.filter((u) => /\/jobs\/view\//.test(u))).toHaveLength(0);
  });
});
