/**
 * Port of opencli's clis/linkedin/people-search.test.js.
 * Pure-helper assertions via __test__, plus func tests with inline fake pages
 * (goto/wait/getCookies/evaluate).
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@base/runtime/errors.js';
import '../../../marketplace/linkedin/people-search.js';

const {
  parseLimit,
  buildSearchUrl,
  looksLinkedInAuthWall,
  normalizeProfileUrl,
  normalizePeopleRows,
  parseNonNegativeCount,
  extractionScript,
} = (await import('../../../marketplace/linkedin/people-search.js')).__test__ as any;

function extractionResult(rows: any[], counts: any = {}) {
  return {
    rows,
    candidate_count: counts.candidate_count ?? rows.length,
    person_entries_count: counts.person_entries_count ?? counts.candidate_count ?? rows.length,
    resolved_count: counts.resolved_count ?? rows.length,
  };
}

function makePage({
  evaluateResult,
  evaluateReject,
  gotoReject,
  cookies = [{ name: 'JSESSIONID', value: '"ajax:1234567890"' }],
}: any = {}) {
  return {
    goto: vi
      .fn()
      .mockImplementation(() =>
        gotoReject ? Promise.reject(gotoReject) : Promise.resolve(undefined),
      ),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue(cookies),
    evaluate: vi
      .fn()
      .mockImplementation(() =>
        evaluateReject ? Promise.reject(evaluateReject) : Promise.resolve(evaluateResult),
      ),
  };
}

describe('linkedin people-search command', () => {
  it('builds the canonical SSR search URL with encoded keywords', () => {
    expect(buildSearchUrl('site reliability engineer')).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=site%20reliability%20engineer',
    );
    expect(buildSearchUrl('hello/world & stuff')).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=hello%2Fworld%20%26%20stuff',
    );
  });

  it('validates --limit without silent clamping', () => {
    expect(parseLimit(undefined)).toBe(5);
    expect(parseLimit(1)).toBe(1);
    expect(parseLimit(10)).toBe(10);
    expect(() => parseLimit(0)).toThrow(ArgumentError);
    expect(() => parseLimit(11)).toThrow(ArgumentError);
    expect(() => parseLimit(-1)).toThrow(ArgumentError);
    expect(() => parseLimit('abc')).toThrow(ArgumentError);
    expect(() => parseLimit(1.5)).toThrow(ArgumentError);
  });

  it('extraction script slices main.innerText by person-name boundaries', () => {
    const s = extractionScript();
    expect(s).toContain('a[href*="/in/"]');
    expect(s).toContain('\\/in\\/([^/?#]+)');
    expect(s).toContain('main.innerText');
    expect(s).toContain('lines.findIndex');
    expect(s).toContain('mutual connection');
    expect(s).toContain('seenHandles');
    expect(s).toContain('span[aria-hidden="true"]');
    expect(s).toContain('search\\/results\\/people');
    expect(s).toContain('candidate_count');
    expect(s).toContain('resolved_count');
  });

  it('normalizes only stable LinkedIn profile identities', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/alice-engineer/?mini=true')).toBe(
      'https://www.linkedin.com/in/alice-engineer/',
    );
    expect(normalizeProfileUrl('https://linkedin.com/in/bob-builder')).toBe(
      'https://www.linkedin.com/in/bob-builder/',
    );
    expect(normalizeProfileUrl('https://evil-linkedin.com/in/bob-builder')).toBe('');
    expect(normalizeProfileUrl('http://www.linkedin.com/in/bob-builder')).toBe('');
    expect(normalizeProfileUrl('https://www.linkedin.com/company/opencli')).toBe('');
  });

  it('detects LinkedIn auth-wall URLs separately from CUL redirects', () => {
    expect(looksLinkedInAuthWall('https://www.linkedin.com/authwall Sign in to continue')).toBe(
      true,
    );
    expect(
      looksLinkedInAuthWall(
        'https://www.linkedin.com/checkpoint/challenge security verification required',
      ),
    ).toBe(true);
    expect(looksLinkedInAuthWall('https://www.linkedin.com/feed/')).toBe(false);
  });

  it('rejects malformed extraction rows instead of fabricating success rows', () => {
    expect(() => normalizePeopleRows({})).toThrow(CommandExecutionError);
    expect(() => normalizePeopleRows([null])).toThrow(CommandExecutionError);
    expect(() =>
      normalizePeopleRows([{ name: 'No URL', headline: 'h', location: 'l', profile_url: '' }]),
    ).toThrow(CommandExecutionError);
    expect(() =>
      normalizePeopleRows([
        { name: '', headline: 'h', location: 'l', profile_url: 'https://www.linkedin.com/in/no-name/' },
      ]),
    ).toThrow(CommandExecutionError);
  });

  it('validates extraction evidence counters', () => {
    expect(parseNonNegativeCount(0, 'candidate_count')).toBe(0);
    expect(parseNonNegativeCount(2, 'candidate_count')).toBe(2);
    expect(() => parseNonNegativeCount(undefined, 'candidate_count')).toThrow(CommandExecutionError);
    expect(() => parseNonNegativeCount(-1, 'candidate_count')).toThrow(CommandExecutionError);
    expect(() => parseNonNegativeCount(1.2, 'candidate_count')).toThrow(CommandExecutionError);
  });

  it('returns ranked rows when the page yields people', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    expect(cmd?.func).toBeTypeOf('function');
    const page = makePage({
      evaluateResult: extractionResult([
        {
          name: 'Alice Engineer',
          headline: 'Staff SWE at Acme',
          location: 'Berlin',
          profile_url: 'https://www.linkedin.com/in/alice-engineer/',
        },
        {
          name: 'Bob Builder',
          headline: 'CTO at Globex',
          location: 'Remote',
          profile_url: 'https://www.linkedin.com/in/bob-builder/',
        },
      ]),
    });
    const result = await cmd!.func!(page, { keywords: 'reinforcement learning', limit: 5 });
    expect(page.goto).toHaveBeenCalledWith(
      'https://www.linkedin.com/search/results/people/?keywords=reinforcement%20learning',
    );
    expect(result).toEqual([
      {
        rank: 1,
        name: 'Alice Engineer',
        headline: 'Staff SWE at Acme',
        location: 'Berlin',
        profile_url: 'https://www.linkedin.com/in/alice-engineer/',
      },
      {
        rank: 2,
        name: 'Bob Builder',
        headline: 'CTO at Globex',
        location: 'Remote',
        profile_url: 'https://www.linkedin.com/in/bob-builder/',
      },
    ]);
  });

  it('slices to --limit when more rows are extracted than requested', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({
      evaluateResult: extractionResult(
        Array.from({ length: 8 }, (_, i) => ({
          name: `Person ${i}`,
          headline: 'h',
          location: 'l',
          profile_url: `https://www.linkedin.com/in/p${i}/`,
        })),
      ),
    });
    const result = (await cmd!.func!(page, { keywords: 'x', limit: 3 })) as any[];
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('throws AuthRequiredError when JSESSIONID cookie is missing', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ cookies: [], evaluateResult: extractionResult([]) });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('treats malformed cookie lookup results as CommandExecutionError', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ cookies: null, evaluateResult: extractionResult([]) });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('treats LinkedIn redirect away from search page as a CUL-flavoured CommandExecutionError', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({
      evaluateResult: { error: 'not on people search page', url: 'https://www.linkedin.com/' },
    });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('treats LinkedIn auth-wall redirects as AuthRequiredError', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({
      evaluateResult: {
        error: 'not on people search page',
        url: 'https://www.linkedin.com/authwall?trk=people_search',
      },
    });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('wraps browser extraction exceptions as CommandExecutionError', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ evaluateReject: new SyntaxError('Unexpected token <') });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('wraps browser navigation exceptions as CommandExecutionError', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ gotoReject: new Error('navigation failed') });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('throws EmptyResultError when the page rendered zero rows', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ evaluateResult: extractionResult([]) });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      EmptyResultError,
    );
  });

  it('treats profile candidates without stable parsed rows as parser drift', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({
      evaluateResult: extractionResult([], {
        candidate_count: 1,
        person_entries_count: 1,
        resolved_count: 0,
      }),
    });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('treats missing rows array as parser drift, not empty results', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ evaluateResult: {} });
    await expect(cmd!.func!(page, { keywords: 'x', limit: 5 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('rejects empty keywords with ArgumentError before navigation', async () => {
    const cmd = findAdapter('linkedin', 'people-search');
    const page = makePage({ evaluateResult: extractionResult([]) });
    await expect(cmd!.func!(page, { keywords: '   ', limit: 5 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('registers with the expected columns and arg shape', () => {
    const cmd = findAdapter('linkedin', 'people-search');
    expect(cmd?.columns).toEqual(['rank', 'name', 'headline', 'location', 'profile_url']);
    expect(cmd?.access).toBe('read');
    expect(cmd?.browser).toBe(true);
    const keywordsArg = cmd?.args?.find((a: any) => a.name === 'keywords');
    expect(keywordsArg?.positional).toBe(true);
    expect(keywordsArg?.required).toBe(true);
  });
});
