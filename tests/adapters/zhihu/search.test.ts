/**
 * Port of opencli's clis/zhihu/search.test.js.
 *
 * Read adapter: page.goto then page.evaluate(<search_v3 fetch IIFE>). The
 * bundled file re-exports __test__ helpers (normalizeSearchUrl,
 * requireSearchPayload, normalizeResultItem), so the pure-helper assertions
 * port directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@base/runtime/errors.js';
import { __test__ } from '../../../marketplace/zhihu/search.js';

const { normalizeSearchUrl, requireSearchPayload, normalizeResultItem, deriveQuestionRow } =
  __test__;

describe('zhihu search (marketplace)', () => {
  it('returns search_result entries from the Zhihu search API', async () => {
    const cmd = findAdapter('zhihu', 'search');
    expect(cmd?.func).toBeTypeOf('function');
    const goto = vi.fn().mockResolvedValue(undefined);
    const evaluate = vi.fn().mockImplementation(async (js) => {
      expect(js).toContain('/api/v4/search_v3');
      expect(js).toContain('limit=20');
      expect(js).toContain("credentials: 'include'");
      return {
        data: [
          {
            type: 'hot_timing',
            object: {
              type: 'hot_timing',
              content_items: [
                { object: { id: 'discussion-1', type: 'article', title: 'discussion' } },
              ],
            },
          },
          {
            type: 'search_result',
            object: {
              id: 'a1',
              type: 'answer',
              author: { name: 'alice' },
              voteup_count: 12,
              question: { id: 'q1', name: '<em>Codex</em> &#34;question&#34;' },
            },
          },
          {
            type: 'search_result',
            object: {
              id: 'p1',
              type: 'article',
              title: '<em>Codex</em> article',
              author: { name: 'bob' },
              voteup_count: 7,
            },
          },
        ],
        paging: { is_end: true },
      };
    });
    const page = { goto, evaluate };
    await expect(cmd!.func!(page, { query: 'codex', limit: 2 })).resolves.toEqual([
      {
        rank: 1,
        title: 'Codex "question"',
        type: 'answer',
        author: 'alice',
        votes: 12,
        url: 'https://www.zhihu.com/question/q1/answer/a1',
      },
      {
        rank: 2,
        title: 'Codex article',
        type: 'article',
        author: 'bob',
        votes: 7,
        url: 'https://zhuanlan.zhihu.com/p/p1',
      },
    ]);
    expect(goto).toHaveBeenCalledWith('https://www.zhihu.com');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('follows paging.next until the requested limit is reached', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            { type: 'search_result', object: { id: 'a1', type: 'answer', question: { id: 'q1', name: 'first' } } },
            { type: 'search_result', object: { id: 'a2', type: 'answer', question: { id: 'q2', name: 'second' } } },
          ],
          paging: {
            is_end: false,
            next: 'https://api.zhihu.com/search_v3?offset=20&q=codex',
          },
        })
        .mockResolvedValueOnce({
          data: [
            { type: 'search_result', object: { id: 'a2', type: 'answer', question: { id: 'q2', name: 'duplicate' } } },
            { type: 'search_result', object: { id: 'q3', type: 'question', title: 'third' } },
          ],
          paging: { is_end: true },
        }),
    };
    await expect(cmd!.func!(page, { query: 'codex', limit: 3 })).resolves.toEqual([
      { rank: 1, title: 'first', type: 'answer', author: '', votes: 0, url: 'https://www.zhihu.com/question/q1/answer/a1' },
      { rank: 2, title: 'second', type: 'answer', author: '', votes: 0, url: 'https://www.zhihu.com/question/q2/answer/a2' },
      { rank: 3, title: 'third', type: 'question', author: '', votes: 0, url: 'https://www.zhihu.com/question/q3' },
    ]);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.evaluate.mock.calls[1][0]).toContain('https://www.zhihu.com/api/v4/search_v3?offset=20&q=codex');
  });

  it('filters by result type', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        data: [
          { type: 'search_result', object: { id: 'a1', type: 'answer' } },
          { type: 'search_result', object: { id: 'p1', type: 'article', title: 'article' } },
        ],
        paging: { is_end: true },
      }),
    };
    await expect(cmd!.func!(page, { query: 'codex', limit: 2, type: 'article' })).resolves.toEqual([
      { rank: 1, title: 'article', type: 'article', author: '', votes: 0, url: 'https://zhuanlan.zhihu.com/p/p1' },
    ]);
  });

  it('maps auth-like failures to AuthRequiredError', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ __httpError: 403 }),
    };
    await expect(cmd!.func!(page, { query: 'codex', limit: 3 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('preserves non-auth fetch failures as typed execution errors', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ __httpError: 500 }),
    };
    await expect(cmd!.func!(page, { query: 'codex', limit: 3 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('rejects invalid input before navigation', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = { goto: vi.fn(), evaluate: vi.fn() };
    await expect(cmd!.func!(page, { query: '', limit: 1 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd!.func!(page, { query: 'codex', limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(cmd!.func!(page, { query: 'codex', limit: 1001 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    await expect(cmd!.func!(page, { query: 'codex', limit: 1, type: 'video' })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('unwraps Browser Bridge envelopes and fails typed on malformed payloads', () => {
    const payload = { data: [], paging: { is_end: true } };
    expect(
      requireSearchPayload({ session: {}, data: payload }, 'https://www.zhihu.com/api/v4/search_v3'),
    ).toBe(payload);
    expect(() => requireSearchPayload(null, 'url')).toThrow(CommandExecutionError);
    expect(() => requireSearchPayload({ data: null, paging: { is_end: true } }, 'url')).toThrow(
      CommandExecutionError,
    );
    expect(() => requireSearchPayload({ data: [], paging: null }, 'url')).toThrow(
      CommandExecutionError,
    );
    expect(() => requireSearchPayload({ __fetchError: 'network down' }, 'url')).toThrow(
      CommandExecutionError,
    );
  });

  it('fails typed on malformed supported result rows instead of emitting blank identity rows', () => {
    expect(() =>
      normalizeResultItem({
        type: 'search_result',
        object: { type: 'answer', id: 'a1', question: { name: 'missing question id' } },
      }),
    ).toThrow(CommandExecutionError);
    expect(() =>
      normalizeResultItem({ type: 'search_result', object: { type: 'article', id: 'p1' } }),
    ).toThrow(CommandExecutionError);
    expect(normalizeResultItem({ type: 'hot_timing', object: { type: 'article', id: 'p1' } })).toBe(
      null,
    );
  });

  it('rejects malformed pagination next URLs and reports valid empty result separately', async () => {
    expect(normalizeSearchUrl('https://api.zhihu.com/search_v3?offset=20&q=codex')).toBe(
      'https://www.zhihu.com/api/v4/search_v3?offset=20&q=codex',
    );
    expect(normalizeSearchUrl('https://evil.example/search_v3?offset=20')).toBe('');

    const cmd = findAdapter('zhihu', 'search');
    const malformedNextPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        data: [],
        paging: { is_end: false, next: 'https://evil.example/search_v3?offset=20' },
      }),
    };
    await expect(cmd!.func!(malformedNextPage, { query: 'codex', limit: 3 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );

    const emptyPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ data: [], paging: { is_end: true } }),
    };
    await expect(cmd!.func!(emptyPage, { query: 'codex', limit: 3 })).rejects.toBeInstanceOf(
      EmptyResultError,
    );
  });

  // type=question fix: Zhihu's general search returns mostly answers/articles, so
  // the old strict "question objects only" filter came back empty for normal
  // queries. Now we derive the QUESTION behind each hit (direct, or an answer's
  // parent), deduped by question id.
  it('type=question derives the questions behind answers (dedup, articles excluded)', async () => {
    const cmd = findAdapter('zhihu', 'search');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        data: [
          // answer → parent question q1
          {
            type: 'search_result',
            object: { id: 'a1', type: 'answer', voteup_count: 99, question: { id: 'q1', name: '气血怎么调?' } },
          },
          // a second answer for the SAME question q1 → deduped away
          {
            type: 'search_result',
            object: { id: 'a2', type: 'answer', voteup_count: 50, question: { id: 'q1', name: '气血怎么调?' } },
          },
          // an article → has no parent question → excluded
          { type: 'search_result', object: { id: 'p1', type: 'article', title: '补气血' } },
          // answer → parent question q2
          {
            type: 'search_result',
            object: { id: 'a3', type: 'answer', voteup_count: 7, question: { id: 'q2', name: '肾阴虚吃什么?' } },
          },
        ],
        paging: { is_end: true },
      }),
    };
    await expect(cmd!.func!(page, { query: '气血', limit: 10, type: 'question' })).resolves.toEqual([
      { rank: 1, title: '气血怎么调?', type: 'question', author: '', votes: 99, url: 'https://www.zhihu.com/question/q1' },
      { rank: 2, title: '肾阴虚吃什么?', type: 'question', author: '', votes: 7, url: 'https://www.zhihu.com/question/q2' },
    ]);
  });
});

describe('zhihu search deriveQuestionRow (unit)', () => {
  it('uses a direct question hit', () => {
    expect(deriveQuestionRow({ type: 'question', id: 488854004, title: '气血不足应该怎么调理身体?' })).toEqual({
      key: 'question:488854004',
      row: {
        title: '气血不足应该怎么调理身体?',
        type: 'question',
        author: '',
        votes: 0,
        url: 'https://www.zhihu.com/question/488854004',
      },
    });
  });

  it("derives the parent question from an answer hit, carrying the answer's upvotes", () => {
    const r = deriveQuestionRow({
      type: 'answer',
      id: 2904039595,
      voteup_count: 3483,
      question: { id: 488854004, name: '气血不足应该怎么调理身体?' },
    });
    expect(r?.key).toBe('question:488854004');
    expect(r?.row.url).toBe('https://www.zhihu.com/question/488854004');
    expect(r?.row.type).toBe('question');
    expect(r?.row.votes).toBe(3483);
  });

  it('returns null for articles, question-less answers, and titleless questions', () => {
    expect(deriveQuestionRow({ type: 'article', id: 1 })).toBeNull();
    expect(deriveQuestionRow({ type: 'answer', id: 2, voteup_count: 1 })).toBeNull();
    expect(deriveQuestionRow({ type: 'answer', id: 3, question: { id: 9 } })).toBeNull();
  });

  it('strips HTML from the derived title', () => {
    const r = deriveQuestionRow({ type: 'answer', id: 1, question: { id: 2, name: '如何<em>调理</em>气血?' } });
    expect(r?.row.title).toBe('如何调理气血?');
  });
});
