/**
 * Port of opencli's clis/reddit/subscribed.test.js.
 *
 * subscribed is a FUNC adapter. Pure helpers (parseRedditSubscribedLimit /
 * unwrapEvaluateResult) are re-exported by the bundled file. The bundled
 * adapter also imports BROWSER_JSON_SNIFF_FN / throwIfLoginWall from
 * '@jackwener/opencli/utils' (aliased to src/runtime/opencli/utils.ts), so the
 * login-wall sentinel path constructs a real LoginWallError on the Node side.
 * `evaluate` envelope is canned via makeFakeRedditPage. Lookup + error
 * imports swapped.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  LoginWallError,
} from '@base/runtime/errors.js';
import { makeFakeRedditPage } from '../_helpers/reddit-page.js';

import {
  parseRedditSubscribedLimit,
  unwrapEvaluateResult,
} from '../../../marketplace/reddit/subscribed.js';
import '../../../marketplace/reddit/subscribed.js';

function subredditThing(id: string, overrides: Record<string, unknown> = {}) {
  const displayName = `sub${id}`;
  return {
    kind: 't5',
    data: {
      id,
      name: `t5_${id}`,
      display_name: displayName,
      display_name_prefixed: `r/${displayName}`,
      title: `Sub ${id}`,
      subscribers: 1000,
      public_description: `Description ${id}`,
      url: `/r/${displayName}/`,
      ...overrides,
    },
  };
}

describe('reddit subscribed adapter (marketplace)', () => {
  const command = findAdapter('reddit', 'subscribed');

  it('registers with id-bearing output columns', () => {
    expect(command).toBeDefined();
    expect(command!.columns).toEqual(['id', 'subreddit', 'title', 'subscribers', 'description', 'url']);
  });

  it('parseRedditSubscribedLimit rejects out-of-range values without silent clamp', () => {
    expect(parseRedditSubscribedLimit(undefined)).toBe(100);
    expect(parseRedditSubscribedLimit(null)).toBe(100);
    expect(parseRedditSubscribedLimit('')).toBe(100);
    expect(parseRedditSubscribedLimit(1)).toBe(1);
    expect(parseRedditSubscribedLimit(1000)).toBe(1000);
    for (const bad of [0, -1, 1001, 1.5, NaN, 'abc']) {
      expect(() => parseRedditSubscribedLimit(bad)).toThrow(ArgumentError);
    }
  });

  it('rejects bad limit before navigation', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', entries: [] });
    await expect(command!.func!(page, { limit: 1001 })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('unwraps Browser Bridge envelopes', () => {
    const inner = { kind: 'ok', entries: [] };
    expect(unwrapEvaluateResult({ session: 'browser:default', data: inner })).toBe(inner);
    expect(unwrapEvaluateResult(inner)).toBe(inner);
  });

  it('returns subscribed subreddits from the browser-evaluated payload', async () => {
    const page = makeFakeRedditPage({
      kind: 'ok',
      entries: [
        subredditThing('abc', {
          display_name: 'programming',
          display_name_prefixed: 'r/programming',
          title: 'Programming',
          subscribers: 6000000,
          public_description: 'All things code',
          url: '/r/programming/',
        }),
        subredditThing('def', {
          display_name: 'MachineLearning',
          display_name_prefixed: 'r/MachineLearning',
          title: 'Machine Learning',
          subscribers: 3000000,
          public_description: 'ML research',
          url: '/r/MachineLearning/',
        }),
      ],
    });
    const result = await command!.func!(page, { limit: 100 });
    expect(page.goto).toHaveBeenCalledWith('https://www.reddit.com');
    expect(result).toEqual([
      { id: 't5_abc', subreddit: 'r/programming', title: 'Programming', subscribers: 6000000, description: 'All things code', url: 'https://www.reddit.com/r/programming/' },
      { id: 't5_def', subreddit: 'r/MachineLearning', title: 'Machine Learning', subscribers: 3000000, description: 'ML research', url: 'https://www.reddit.com/r/MachineLearning/' },
    ]);
  });

  it('throws AuthRequiredError when not logged in', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'auth', detail: 'login required' }), { limit: 100 }))
      .rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('surfaces HTTP, malformed, exception, and unexpected envelopes as CommandExecutionError', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'http', httpStatus: 429, where: '/subreddits/mine/subscriptions.json?limit=100' }), { limit: 100 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'malformed', detail: 'missing data.children' }), { limit: 100 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'exception', detail: 'network' }), { limit: 100 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ ok: true }), { limit: 100 }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('converts a browser-side login-wall sentinel into a typed LoginWallError', async () => {
    const sentinel = {
      __loginWall: true,
      status: 200,
      url: 'https://www.reddit.com/api/me.json?raw_json=1',
      contentType: 'text/html; charset=utf-8',
      bodyPreview: '<!DOCTYPE html><html><head><title>reddit.com: over 18?</title>',
    };
    const page = makeFakeRedditPage({ kind: 'login-wall', sentinel, where: '/api/me.json' });
    try {
      await command!.func!(page, { limit: 100 });
      throw new Error('expected LoginWallError, got success');
    } catch (err) {
      expect(err).toBeInstanceOf(LoginWallError);
      expect((err as LoginWallError).status).toBe(200);
      expect((err as LoginWallError).url).toBe('/api/me.json');
      expect((err as LoginWallError).bodyPreview).toContain('reddit.com: over 18');
    }
  });

  it('throws EmptyResultError for a valid empty subscriptions list', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'ok', entries: [] }), { limit: 100 }))
      .rejects.toBeInstanceOf(EmptyResultError);
  });

  // F-20: identity-less rows are now SKIPPED (not thrown) — subscriber.json
  // includes the user's own profile sub (u_<name>, url /user/…) which has no /r/
  // path; throwing on it blanked the whole list. All-invalid → EmptyResultError.
  it('skips rows lacking subreddit identity (all-skipped → EmptyResultError)', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'ok', entries: [subredditThing('abc', { name: '', id: '', display_name: '', display_name_prefixed: '', url: '' })] }), { limit: 100 }))
      .rejects.toBeInstanceOf(EmptyResultError);
  });

  it('skips identity-less rows but keeps valid ones (profile-sub shape)', async () => {
    const rows = (await command!.func!(makeFakeRedditPage({
      kind: 'ok',
      entries: [
        subredditThing('profile', { name: '', id: '', display_name: '', display_name_prefixed: '', url: '/user/me/' }),
        subredditThing('good'),
      ],
    }), { limit: 100 })) as Array<{ subreddit: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].subreddit).toContain('good');
  });

  it('does not synthesize subreddit identity from a non-t5 listing item', async () => {
    // Still NOT synthesized — the non-t5 row is skipped (→ empty), never returned.
    await expect(command!.func!(makeFakeRedditPage({
      kind: 'ok',
      entries: [{
        kind: 't3',
        data: {
          id: 'abc',
          display_name: 'notasub',
          display_name_prefixed: 'r/notasub',
          url: '/r/notasub/',
        },
      }],
    }), { limit: 100 })).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('respects --limit by slicing the final result', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', entries: Array.from({ length: 5 }, (_, i) => subredditThing(String(i))) });
    const result = (await command!.func!(page, { limit: 3 })) as Array<{ subreddit: string }>;
    expect(result).toHaveLength(3);
    expect(result[0].subreddit).toBe('r/sub0');
  });

  it('embeds the validated limit literally in the browser script', async () => {
    const page = makeFakeRedditPage({ kind: 'ok', entries: [subredditThing('x')] });
    await command!.func!(page, { limit: 7 });
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('const target = 7');
  });
});
