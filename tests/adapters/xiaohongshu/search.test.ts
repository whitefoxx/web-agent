/**
 * Port of opencli's clis/xiaohongshu/search.test.js.
 *
 * The bundled marketplace/xiaohongshu/search.js re-exports `noteIdToDate`,
 * `buildScrollUntilJs`, `unwrapEvaluateResult`, `parseLimit` and
 * `__test__.stripXhsAuthorDateSuffix`, so all pure-helper tests are ported.
 *
 * Two opencli func/helper tests eval the generated DOM-extraction / scroll
 * IIFEs against a real `jsdom` document; both are now ported via the `jsdom`
 * devDep:
 *   - 'separates fallback author text from appended relative date'
 *     (in the `xiaohongshu/search (marketplace)` block)
 *   - buildScrollUntilJs › 'counts only visible real note rows'
 * Their non-DOM cores remain covered too: stripXhsAuthorDateSuffix below covers
 * the author/date separation logic, and the other buildScrollUntilJs tests
 * cover its string-generation behavior.
 *
 * All remaining func tests use opencli's sequenced createPageMock([...]) where
 * each evaluate call resolves the next queued value.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeXiaohongshuPage } from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/search.js';
import {
  __test__,
  buildScrollUntilJs,
  buildSearchExtractJs,
  noteIdToDate,
  unwrapEvaluateResult,
} from '../../../marketplace/xiaohongshu/search.js';

// jsdom does no layout, so getBoundingClientRect() returns all-zero rects and
// the extraction/scroll scripts treat every node as invisible. Stub a non-zero
// rect on the nodes a test wants counted (verbatim from opencli's test).
function markVisible(el: Element): void {
  (el as unknown as { getBoundingClientRect: () => { width: number; height: number } }).getBoundingClientRect =
    () => ({ width: 100, height: 100 });
}

function createPageMock(evaluateResults: unknown[]) {
  const page = makeFakeXiaohongshuPage();
  const evaluate = page.evaluate;
  evaluate.mockReset();
  for (const result of evaluateResults) evaluate.mockResolvedValueOnce(result);
  evaluate.mockResolvedValue(undefined);
  return page;
}

describe('xiaohongshu/search (marketplace)', () => {
  const getCommand = () => findAdapter('xiaohongshu', 'search');

  it('rejects invalid limit before browser navigation', async () => {
    const cmd = getCommand();
    const page = createPageMock([]);

    await expect(cmd!.func!(page, { query: '特斯拉', limit: 0 })).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('--limit'),
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('throws a clear error when the search page is blocked by a login wall', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock(['login_wall']);
    await expect(cmd!.func!(page, { query: '特斯拉', limit: 5 })).rejects.toThrow(
      'Xiaohongshu search results are blocked behind a login wall',
    );
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.autoScroll).not.toHaveBeenCalled();
  });

  it('unwraps a browser-bridge envelope before handling login-wall wait result', async () => {
    const cmd = getCommand();
    const page = createPageMock([{ session: 'site:xiaohongshu', data: 'login_wall' }]);

    await expect(cmd!.func!(page, { query: '特斯拉', limit: 5 })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      message: expect.stringContaining('blocked behind a login wall'),
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns ranked results with search_result url and author_url preserved', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const detailUrl =
      'https://www.xiaohongshu.com/search_result/68e90be80000000004022e66?xsec_token=test-token&xsec_source=';
    const authorUrl =
      'https://www.xiaohongshu.com/user/profile/635a9c720000000018028b40?xsec_token=user-token&xsec_source=pc_search';
    const rows = [
      {
        title: '某鱼买FSD被坑了4万',
        author: '随风',
        likes: '261',
        url: detailUrl,
        author_url: authorUrl,
      },
    ];
    const page = createPageMock(['content', { session: 'site:xiaohongshu', data: rows }]);
    const result = await cmd!.func!(page, { query: '特斯拉', limit: 1 });
    expect(page.goto.mock.calls).toHaveLength(1);
    expect(result).toEqual([
      {
        rank: 1,
        title: '某鱼买FSD被坑了4万',
        author: '随风',
        likes: '261',
        published_at: '2025-10-10',
        url: detailUrl,
        author_url: authorUrl,
      },
    ]);
  });

  it('fails typed instead of silently returning [] for malformed extraction payloads', async () => {
    const cmd = getCommand();
    const page = createPageMock(['content', { session: 'site:xiaohongshu', data: { rows: [] } }]);

    await expect(cmd!.func!(page, { query: '测试', limit: 1 })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('payload shape'),
    });
  });

  it('filters out results with no title and respects the limit', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([
      'content',
      [
        {
          title: 'Result A',
          author: 'UserA',
          likes: '10',
          url: 'https://www.xiaohongshu.com/search_result/aaa',
          author_url: '',
        },
        {
          title: '',
          author: 'UserB',
          likes: '5',
          url: 'https://www.xiaohongshu.com/search_result/bbb',
          author_url: '',
        },
        {
          title: 'Result C',
          author: 'UserC',
          likes: '3',
          url: 'https://www.xiaohongshu.com/search_result/ccc',
          author_url: '',
        },
      ],
    ]);
    const result = (await cmd!.func!(page, { query: '测试', limit: 1 })) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rank: 1, title: 'Result A' });
  });

  it('waits for content via MutationObserver before extracting', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([
      'content', // wait
      [], // initial extraction (no rows)
      0, // scroll-until row count
      [], // post-scroll extraction (still no rows)
    ]);
    const result = (await cmd!.func!(page, { query: '测试等待', limit: 5 })) as unknown[];
    expect(result).toHaveLength(0);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(4);
  });

  it('scrolls only when the initial extraction has fewer rows than requested', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([
      'content',
      [
        {
          title: 'Result A',
          author: 'UserA',
          likes: '10',
          url: 'https://www.xiaohongshu.com/search_result/aaa',
          author_url: '',
        },
      ],
      3,
      [
        {
          title: 'Result A',
          author: 'UserA',
          likes: '10',
          url: 'https://www.xiaohongshu.com/search_result/aaa',
          author_url: '',
        },
        {
          title: 'Result B',
          author: 'UserB',
          likes: '5',
          url: 'https://www.xiaohongshu.com/search_result/bbb',
          author_url: '',
        },
      ],
    ]);

    const result = (await cmd!.func!(page, { query: '测试等待', limit: 2 })) as Array<{ title: string }>;

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.title)).toEqual(['Result A', 'Result B']);
    expect(page.evaluate).toHaveBeenCalledTimes(4);
  });

  // jsdom-backed port of opencli's "separates fallback author text from
  // appended relative date" test. Now that jsdom is a devDep, eval the
  // extraction IIFE (buildSearchExtractJs, the same builder the func calls with
  // 'www.xiaohongshu.com') against a real DOM and assert the author name is
  // split from the appended relative date ("数字3天前端" kept, "3天前" stripped).
  it('separates fallback author text from appended relative date', () => {
    const dom = new JSDOM(
      `
      <section class="note-item">
        <a class="cover mask" href="/search_result/68e90be80000000004022e66?xsec_token=test-token"></a>
        <div class="title">数字作者测试</div>
        <a class="author" href="/user/profile/author123">
          <span>数字3天前端</span><span>3天前</span>
        </a>
        <span class="count">8</span>
      </section>
    `,
      { url: 'https://www.xiaohongshu.com/search_result?keyword=test' },
    );
    markVisible(dom.window.document.querySelector('section.note-item')!);

    const result = Function(
      'document',
      'getComputedStyle',
      `return (${buildSearchExtractJs('www.xiaohongshu.com')})`,
    )(dom.window.document, dom.window.getComputedStyle.bind(dom.window)) as Array<Record<string, unknown>>;

    expect(result[0]).toMatchObject({
      title: '数字作者测试',
      author: '数字3天前端',
      likes: '8',
      author_url: 'https://www.xiaohongshu.com/user/profile/author123',
    });
  });
});

describe('buildScrollUntilJs', () => {
  it('inlines the target count and default maxScrolls into the generated IIFE', () => {
    const js = buildScrollUntilJs(40);
    expect(js).toContain('countItems() >= 40');
    expect(js).toContain('i < 15');
    expect(js).toContain('plateauRounds');
    expect(js).toContain("classList.contains('query-note-item')");
  });
  it('respects a custom maxScrolls override', () => {
    const js = buildScrollUntilJs(100, 5);
    expect(js).toContain('countItems() >= 100');
    expect(js).toContain('i < 5');
  });
  it('rejects unsafe helper arguments instead of interpolating them into code', () => {
    expect(() => buildScrollUntilJs(0)).toThrow(/targetCount/);
    expect(() => buildScrollUntilJs(10, 0)).toThrow(/maxScrolls/);
  });

  // jsdom-backed port of opencli's "counts only visible real note rows" test.
  // Now that jsdom is a devDep, eval the scroll-until IIFE against a real DOM:
  // it must count only the visible, non-query note row (1), excluding the
  // related-search `.query-note-item` row and the display:none row.
  it('counts only visible real note rows', async () => {
    const dom = new JSDOM(
      `
      <section class="note-item" id="visible"></section>
      <section class="note-item query-note-item" id="query"></section>
      <section class="note-item" id="hidden" style="display:none"></section>
    `,
      { url: 'https://www.xiaohongshu.com/search_result?keyword=test' },
    );
    markVisible(dom.window.document.querySelector('#visible')!);
    markVisible(dom.window.document.querySelector('#query')!);
    markVisible(dom.window.document.querySelector('#hidden')!);

    const result = await Function(
      'document',
      'window',
      'MutationObserver',
      'getComputedStyle',
      `return (${buildScrollUntilJs(1)})`,
    )(
      dom.window.document,
      dom.window,
      dom.window.MutationObserver,
      dom.window.getComputedStyle.bind(dom.window),
    );

    expect(result).toBe(1);
  });
});

describe('stripXhsAuthorDateSuffix', () => {
  it('only strips trailing date suffixes and preserves date-like author text', () => {
    expect(__test__.stripXhsAuthorDateSuffix('作者名 3天前')).toBe('作者名');
    expect(__test__.stripXhsAuthorDateSuffix('作者名2026-04-01')).toBe('作者名');
    expect(__test__.stripXhsAuthorDateSuffix('3天前端工程师')).toBe('3天前端工程师');
    expect(__test__.stripXhsAuthorDateSuffix('刚刚好')).toBe('刚刚好');
    expect(__test__.stripXhsAuthorDateSuffix('刚刚')).toBe('刚刚');
  });
});

describe('noteIdToDate (ObjectID timestamp parsing)', () => {
  it('parses a known note ID to the correct China-timezone date', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/search_result/697f6c74000000002103de17')).toBe(
      '2026-02-01',
    );
    expect(noteIdToDate('https://www.xiaohongshu.com/explore/68e90be80000000004022e66')).toBe(
      '2025-10-10',
    );
  });
  it('returns China date when UTC+8 crosses into the next day', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/search_result/69b739f00000000000000000')).toBe(
      '2026-03-16',
    );
  });
  it('handles /note/ path variant', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/note/697f6c74000000002103de17')).toBe('2026-02-01');
  });
  it('handles URL with query parameters', () => {
    expect(
      noteIdToDate('https://www.xiaohongshu.com/search_result/697f6c74000000002103de17?xsec_token=abc'),
    ).toBe('2026-02-01');
  });
  it('returns empty string for non-matching URLs', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/user/profile/635a9c720000000018028b40')).toBe('');
    expect(noteIdToDate('https://www.xiaohongshu.com/')).toBe('');
  });
  it('returns empty string for IDs shorter than 24 hex chars', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/search_result/abcdef')).toBe('');
  });
  it('returns empty string when timestamp is out of range', () => {
    expect(noteIdToDate('https://www.xiaohongshu.com/search_result/000000000000000000000000')).toBe('');
  });
});

describe('unwrapEvaluateResult (browser-bridge envelope normalization)', () => {
  it('returns the raw array unchanged when payload is already an array', () => {
    const arr = [{ title: 'a' }, { title: 'b' }];
    expect(unwrapEvaluateResult(arr)).toBe(arr);
  });
  it('unwraps { session, data: [...] } envelope to the inner array', () => {
    const arr = [{ title: 'a' }];
    const env = { session: 'site:xiaohongshu:abc', data: arr };
    expect(unwrapEvaluateResult(env)).toBe(arr);
  });
  it('unwraps primitive data from Browser Bridge envelopes', () => {
    expect(unwrapEvaluateResult({ session: 'site:xiaohongshu:abc', data: 'login_wall' })).toBe(
      'login_wall',
    );
  });
  it('passes non-envelope objects through unchanged', () => {
    const obj = { results: [], loginWall: true };
    expect(unwrapEvaluateResult(obj)).toBe(obj);
  });
  it('handles null and undefined safely', () => {
    expect(unwrapEvaluateResult(null)).toBe(null);
    expect(unwrapEvaluateResult(undefined)).toBe(undefined);
  });
  it('unwraps non-array envelope data so callers can validate the payload shape', () => {
    const env = { session: 'x', data: { not: 'an array' } };
    expect(unwrapEvaluateResult(env)).toEqual({ not: 'an array' });
  });
});
