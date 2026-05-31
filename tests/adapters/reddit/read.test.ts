/**
 * Port of opencli's clis/reddit/read.test.js.
 *
 * read is a FUNC adapter. Pure helpers (normalizeRedditPostId /
 * parseExpandRounds) are re-exported by the bundled file. Two seams are used:
 *   - makeFakeRedditPage(result)  → canned discriminated-union envelope
 *     (opencli's makePage).
 *   - makeRuntimeRedditPage(fetch) → really `eval`s the in-page script with a
 *     mocked globalThis.fetch (opencli's makeRuntimePage), exercising the
 *     morechildren re-threading logic for real.
 * Lookup + error imports swapped; substantive assertions preserved verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import {
  makeFakeRedditPage,
  makeRuntimeRedditPage,
  jsonResponse,
} from '../_helpers/reddit-page.js';

import {
  normalizeRedditPostId,
  parseExpandRounds,
} from '../../../marketplace/reddit/read.js';
import '../../../marketplace/reddit/read.js';

function redditPostEnvelope(children: unknown[]) {
  return [
    {
      data: {
        children: [{
          data: {
            title: 'Post title',
            selftext: '',
            author: 'op',
            score: 10,
            is_self: true,
          },
        }],
      },
    },
    { data: { children } },
  ];
}

function commentThing(id: string, body: string, parent = 't3_abc123', score = 1) {
  return {
    kind: 't1',
    data: {
      id,
      name: `t1_${id}`,
      parent_id: parent,
      author: id,
      score,
      body,
      replies: '',
    },
  };
}

function moreThing(id: string, children: string[], parent = 't3_abc123', count = children.length) {
  return {
    kind: 'more',
    data: { id, parent_id: parent, children, count },
  };
}

describe('reddit read adapter (marketplace)', () => {
  const command = findAdapter('reddit', 'read');

  it('uses an ephemeral Reddit site tab by default', () => {
    expect(command?.browser).toBe(true);
    expect(command?.siteSession).toBeUndefined();
    expect(command?.columns).toEqual(['type', 'author', 'score', 'text']);
  });

  it('exposes the new --expand-more / --expand-rounds args', () => {
    const argNames = command!.args!.map((a: { name: string }) => a.name);
    expect(argNames).toContain('expand-more');
    expect(argNames).toContain('expand-rounds');
    const expandMore = command!.args!.find((a: { name: string }) => a.name === 'expand-more');
    expect(expandMore.type).toBe('bool');
    expect(expandMore.default).toBe(false);
    const rounds = command!.args!.find((a: { name: string }) => a.name === 'expand-rounds');
    expect(rounds.type).toBe('int');
    expect(rounds.default).toBe(2);
  });

  describe('normalizeRedditPostId', () => {
    it('accepts bare ids, t3 fullnames, and exact reddit post URLs', () => {
      expect(normalizeRedditPostId('1AbC23')).toBe('1abc23');
      expect(normalizeRedditPostId('t3_1AbC23')).toBe('1abc23');
      expect(normalizeRedditPostId('https://www.reddit.com/r/opencli/comments/1abc23/title_slug/?sort=top')).toBe('1abc23');
      expect(normalizeRedditPostId('https://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/?context=3')).toBe('1abc23');
      expect(normalizeRedditPostId('https://old.reddit.com/comments/1abc23/title_slug/')).toBe('1abc23');
    });

    it('rejects invalid or structurally loose post identities before navigation', () => {
      for (const bad of [
        '',
        't1_okf3s7u',
        'https://reddit.com.evil.com/r/opencli/comments/1abc23/title_slug/',
        'http://www.reddit.com/r/opencli/comments/1abc23/title_slug/',
        'https://www.reddit.com/r/opencli/comments/',
        'https://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/evil',
        'not/a/post',
      ]) {
        expect(() => normalizeRedditPostId(bad)).toThrow(ArgumentError);
      }
    });
  });

  describe('parseExpandRounds', () => {
    it('returns the default for absent input but throws on out-of-range / non-integer', () => {
      expect(parseExpandRounds(undefined)).toBe(2);
      expect(parseExpandRounds(null)).toBe(2);
      expect(parseExpandRounds('')).toBe(2);
      expect(parseExpandRounds(1)).toBe(1);
      expect(parseExpandRounds(5)).toBe(5);
      for (const bad of [0, -1, 6, 1.5, NaN, 'abc']) {
        expect(() => parseExpandRounds(bad)).toThrow(ArgumentError);
      }
    });
  });

  it('rejects a bad --expand-rounds BEFORE navigating', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [] });
    await expect(command!.func!(page, { 'post-id': 'abc123', 'expand-rounds': 99 }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects a bad post identity BEFORE navigating', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [] });
    await expect(command!.func!(page, { 'post-id': 'https://evil.test/r/x/comments/abc/title/' }))
      .rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('returns rows when the evaluate script reports kind=ok', async () => {
    const page = makeFakeRedditPage({
      kind: 'ok',
      rows: [
        { type: 'POST', author: 'alice', score: 10, text: 'Title' },
        { type: 'L0', author: 'bob', score: 5, text: 'Comment' },
      ],
      expandMeta: { rounds: 0, fetched: 0, capped: false, errors: [] },
    });
    const result = await command!.func!(page, { 'post-id': 'abc123', limit: 5 });
    expect(page.goto).toHaveBeenCalledWith('https://www.reddit.com');
    expect(result).toEqual([
      { type: 'POST', author: 'alice', score: 10, text: 'Title' },
      { type: 'L0', author: 'bob', score: 5, text: 'Comment' },
    ]);
  });

  it('maps the five failure kinds to the right typed errors', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'inaccessible', detail: 'post 403' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(EmptyResultError);

    await expect(command!.func!(makeFakeRedditPage({ kind: 'auth', detail: 'morechildren 401' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(AuthRequiredError);

    await expect(command!.func!(makeFakeRedditPage({ kind: 'http', httpStatus: 503, where: '/comments/abc.json' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);

    await expect(command!.func!(makeFakeRedditPage({ kind: 'malformed', detail: 'no comment listing' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);

    await expect(command!.func!(makeFakeRedditPage({ kind: 'parser-drift', detail: 'walker drift' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);

    await expect(command!.func!(makeFakeRedditPage({ kind: 'expand-failed', detail: 'morechildren errors' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('throws CommandExecutionError on an unknown envelope shape (no kind)', async () => {
    await expect(command!.func!(makeFakeRedditPage({ random: 'stuff' }), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage(null), { 'post-id': 'abc123' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('embeds expandMore=false by default and inlines flags into the evaluate script', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [], expandMeta: { rounds: 0, fetched: 0, capped: false, errors: [] } });
    await command!.func!(page, { 'post-id': 'xyz', sort: 'top', limit: 3 });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('var expandMore = false');
    expect(script).toContain('var expandRounds = 2');
    expect(script).toContain('var sort = "top"');
    expect(script).toContain('var limit = 3');
    expect(script).toContain('var postId = "xyz"');
  });

  it('embeds expandMore=true and the requested expandRounds when --expand-more is on', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [], expandMeta: { rounds: 3, fetched: 12, capped: true, errors: [] } });
    await command!.func!(page, { 'post-id': 'xyz', 'expand-more': true, 'expand-rounds': 3 });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('var expandMore = true');
    expect(script).toContain('var expandRounds = 3');
    expect(script).toContain("'/api/morechildren'");
    expect(script).toContain("'api_type=json'");
    expect(script).toContain('encodeURIComponent(linkFullname)');
    expect(script).toContain("encodeURIComponent(batch.join(','))");
  });

  it('normalizes a full reddit URL before building the browser script', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [], expandMeta: { rounds: 0, fetched: 0, capped: false, errors: [] } });
    await command!.func!(page, { 'post-id': 'https://www.reddit.com/r/python/comments/1abc23/title_slug/' });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('var postId = "1abc23"');
    expect(script).not.toContain('postIdRaw.match');
  });

  it('expands morechildren in the original tree position instead of appending to the parent', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('/comments/')) {
        return jsonResponse(redditPostEnvelope([
          commentThing('a', 'A'),
          moreThing('more_top', ['b', 'c']),
          commentThing('d', 'D'),
        ]));
      }
      if (String(url) === '/api/morechildren') {
        return jsonResponse({
          json: {
            errors: [],
            data: { things: [commentThing('b', 'B'), commentThing('c', 'C')] },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const page = makeRuntimeRedditPage(fetchMock);

    const result = (await command!.func!(page, {
      'post-id': 'abc123',
      'expand-more': true,
      limit: 10,
      replies: 10,
    })) as Array<{ author: string }>;

    expect(result.map((row) => row.author)).toEqual(['op', 'a', 'b', 'c', 'd']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/morechildren',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('link_id=t3_abc123'),
      }),
    );
  });

  it('fails expand-more when Reddit returns a child that cannot be placed in the requested tree', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('/comments/')) {
        return jsonResponse(redditPostEnvelope([moreThing('more_top', ['b'])]));
      }
      if (String(url) === '/api/morechildren') {
        return jsonResponse({
          json: {
            errors: [],
            data: { things: [commentThing('b', 'B', 't3_other')] },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const page = makeRuntimeRedditPage(fetchMock);

    await expect(command!.func!(page, {
      'post-id': 'abc123',
      'expand-more': true,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('fails expand-more when Reddit omits a requested child instead of silently dropping the stub', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith('/comments/')) {
        return jsonResponse(redditPostEnvelope([moreThing('more_top', ['b', 'c'])]));
      }
      if (String(url) === '/api/morechildren') {
        return jsonResponse({
          json: {
            errors: [],
            data: { things: [commentThing('b', 'B')] },
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const page = makeRuntimeRedditPage(fetchMock);

    await expect(command!.func!(page, {
      'post-id': 'abc123',
      'expand-more': true,
    })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('uses 5-kind discriminated union keys that DO NOT collide with declared columns', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', rows: [], expandMeta: { rounds: 0, fetched: 0, capped: false, errors: [] } });
    await command!.func!(page, { 'post-id': 'xyz' });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain("kind: 'inaccessible'");
    expect(script).toContain("kind: 'auth'");
    expect(script).toContain("kind: 'http'");
    expect(script).toContain("kind: 'malformed'");
    expect(script).toContain("kind: 'parser-drift'");
    expect(script).toContain("kind: 'expand-failed'");
    expect(script).toContain("kind: 'ok'");
  });
});
