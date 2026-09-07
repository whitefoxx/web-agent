/**
 * Port of opencli's clis/reddit/subreddit-info.test.js.
 *
 * subreddit-info is a FUNC adapter. The pure helper `parseSubredditName` is
 * re-exported by the bundled file. Most tests cann the `evaluate` envelope via
 * makeFakeRedditPage (opencli's makePage); one test runs the real in-page
 * script against a `fetch` mock via `new Function('fetch', ...)` (kept
 * verbatim from opencli — the bundled script is `(async () => {...})()`).
 * Lookup + error imports swapped.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import {
  ArgumentError,
  CommandExecutionError,
  EmptyResultError,
} from '@base/runtime/errors.js';
import { makeFakeRedditPage } from '../_helpers/reddit-page.js';

import { parseSubredditName } from '../../../marketplace/reddit/subreddit-info.js';
import '../../../marketplace/reddit/subreddit-info.js';

describe('reddit subreddit-info command (marketplace)', () => {
  const command = findAdapter('reddit', 'subreddit-info');

  it('registers with the expected shape', () => {
    expect(command).toBeDefined();
    expect(command!.access).toBe('read');
    expect(command!.browser).toBe(true);
    expect(command!.columns).toEqual(['field', 'value']);
  });

  it('parseSubredditName strips prefixes and validates the name shape', () => {
    expect(parseSubredditName('python')).toBe('python');
    expect(parseSubredditName('r/python')).toBe('python');
    expect(parseSubredditName('/r/python')).toBe('python');
    expect(parseSubredditName('  AskReddit  ')).toBe('AskReddit');
    expect(parseSubredditName('aw3some_sub')).toBe('aw3some_sub');
  });

  it('parseSubredditName rejects invalid names without silent fallback', () => {
    for (const bad of [
      '',
      '  ',
      'py',
      '1abc',
      '_sub',
      'has space',
      'has-dash',
      'way_too_long_subreddit_name_here',
    ]) {
      expect(() => parseSubredditName(bad)).toThrow(ArgumentError);
    }
  });

  it('rejects bad subreddit names BEFORE navigating', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', info: {} });
    await expect(command!.func!(page, { name: 'has space' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('throws EmptyResultError for missing / banned / private / quarantined subreddits', async () => {
    for (const detail of ['not found', 'banned', 'private', 'quarantined']) {
      await expect(command!.func!(makeFakeRedditPage({ kind: 'missing', detail }), { name: 'python' }))
        .rejects.toBeInstanceOf(EmptyResultError);
    }
  });

  it('treats HTTP 401/403/404 about.json responses as inaccessible subreddit, not auth-required', async () => {
    for (const status of [401, 403, 404]) {
      const scriptResults: Array<{ kind?: string }> = [];
      const page = {
        goto: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn(async (script: string) => {
          const result = await (new Function('fetch', `return (${script})`))(
            vi.fn(async () => ({ status, ok: false })),
          );
          scriptResults.push(result);
          return result;
        }),
      };
      await expect(command!.func!(page, { name: 'python' })).rejects.toBeInstanceOf(EmptyResultError);
      expect(scriptResults[0]).toMatchObject({ kind: 'missing' });
    }
  });

  it('throws CommandExecutionError on HTTP and exception failure modes', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'http', httpStatus: 500, where: 'about.json' }), { name: 'python' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'exception', detail: 'bad' }), { name: 'python' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('throws CommandExecutionError for malformed 200 subreddit payloads', async () => {
    await expect(command!.func!(makeFakeRedditPage({
      kind: 'malformed',
      detail: 'Reddit returned malformed subreddit info for r/python (missing data.display_name).',
    }), { name: 'python' }))
      .rejects.toMatchObject({
        code: 'COMMAND_EXEC',
        message: expect.stringContaining('malformed subreddit info'),
      });
  });

  it('maps a normal subreddit payload into typed field/value rows', async () => {
    const info = {
      display_name: 'python',
      display_name_prefixed: 'r/python',
      title: 'Python',
      public_description: '  News about the programming language Python.  ',
      subscribers: 1234567,
      active_user_count: 4321,
      over18: false,
      subreddit_type: 'public',
      created_utc: 1201881600, // 2008-02-01
      url: '/r/python/',
    };
    const rows = (await command!.func!(makeFakeRedditPage({ kind: 'ok', info }), { name: 'python' })) as Array<{
      field: string;
      value: unknown;
    }>;
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));

    expect(byField.Name).toBe('r/python');
    expect(byField.Title).toBe('Python');
    expect(byField.Subscribers).toBe('1234567');
    expect(byField['Active Now']).toBe('4321');
    expect(byField.NSFW).toBe('No');
    expect(byField.Type).toBe('public');
    expect(byField.Description).toBe('News about the programming language Python.');
    expect(byField.Created).toBe('2008-02-01');
    expect(byField.URL).toBe('https://www.reddit.com/r/python/');

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['field', 'value']);
    }
  });

  it('falls back to accounts_active when active_user_count is missing', async () => {
    const info = {
      display_name: 'sub',
      display_name_prefixed: 'r/sub',
      accounts_active: 99,
      url: '/r/sub/',
    };
    const rows = (await command!.func!(makeFakeRedditPage({ kind: 'ok', info }), { name: 'sub' })) as Array<{
      field: string;
      value: unknown;
    }>;
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    expect(byField['Active Now']).toBe('99');
  });

  it('emits typed null (not "-" sentinel) when subscribers / activity / created are missing', async () => {
    const info = {
      display_name: 'sparse',
      display_name_prefixed: 'r/sparse',
      url: '/r/sparse/',
    };
    const rows = (await command!.func!(makeFakeRedditPage({ kind: 'ok', info }), { name: 'sparse' })) as Array<{
      field: string;
      value: unknown;
    }>;
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    expect(byField.Subscribers).toBeNull();
    expect(byField['Active Now']).toBeNull();
    expect(byField.Created).toBeNull();
    expect(byField.Description).toBeNull();
    expect(byField.Title).toBeNull();
    expect(byField.Type).toBeNull();
  });

  it('encodes the subreddit name into the fetch URL embedded in evaluate', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', info: { display_name: 'python', display_name_prefixed: 'r/python', url: '/r/python/' } });
    await command!.func!(page, { name: 'r/python' });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('const sub = "python"');
  });
});
