/**
 * Port of opencli's clis/twitter/following.test.js.
 *
 * Mechanism adaptations:
 *  - registry lookup → findAdapter('twitter', 'following')
 *  - error imports    → src/runtime/errors.js
 *  - opencli's EmptyResultError carried a `.hint` field; ours folds the hint
 *    text into `.message` (constructor is `(source, message)`), so the
 *    private-following assertion checks `.message` instead. The substantive
 *    coverage (privacy hint surfaced + EmptyResultError type) is preserved.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import { __test__ } from '../../../marketplace/twitter/following.js';

import '../../../marketplace/twitter/following.js';

describe('twitter following helpers (marketplace)', () => {
  it('falls back when queryId contains unsafe characters', () => {
    expect(__test__.sanitizeQueryId('safe_Query-123', 'fallback')).toBe('safe_Query-123');
    expect(__test__.sanitizeQueryId('bad"id', 'fallback')).toBe('fallback');
    expect(__test__.sanitizeQueryId('bad/id', 'fallback')).toBe('fallback');
    expect(__test__.sanitizeQueryId(null, 'fallback')).toBe('fallback');
  });

  it('builds following url with cursor', () => {
    const url = __test__.buildFollowingUrl('query123', '42', 20, 'cursor-1');
    expect(url).toContain('/i/api/graphql/query123/Following');
    expect(decodeURIComponent(url)).toContain('"userId":"42"');
    expect(decodeURIComponent(url)).toContain('"count":20');
    expect(decodeURIComponent(url)).toContain('"cursor":"cursor-1"');
  });

  it('builds following url without cursor', () => {
    const url = __test__.buildFollowingUrl('query123', '42', 20);
    expect(url).toContain('/i/api/graphql/query123/Following');
    expect(decodeURIComponent(url)).not.toContain('"cursor"');
  });

  it('extracts user from result', () => {
    const user = __test__.extractUser({
      __typename: 'User',
      core: { screen_name: 'alice', name: 'Alice' },
      legacy: { description: 'bio text', followers_count: 100 },
    });
    expect(user).toMatchObject({ screen_name: 'alice', name: 'Alice', bio: 'bio text', followers: 100 });
  });

  it('returns null for non-User typename', () => {
    expect(__test__.extractUser({ __typename: 'Tweet' })).toBeNull();
    expect(__test__.extractUser(null)).toBeNull();
    expect(__test__.extractUser(undefined)).toBeNull();
  });

  it('falls back to legacy screen_name if core is missing', () => {
    const user = __test__.extractUser({
      __typename: 'User',
      legacy: { screen_name: 'bob', name: 'Bob', description: '', followers_count: 0 },
    });
    expect(user?.screen_name).toBe('bob');
  });

  it('parses following timeline with users and cursor', () => {
    const payload = {
      data: {
        user: {
          result: {
            timeline_v2: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        entryId: 'user-1',
                        content: {
                          itemContent: {
                            user_results: {
                              result: {
                                __typename: 'User',
                                core: { screen_name: 'bob', name: 'Bob' },
                                legacy: { description: 'hello', followers_count: 50 },
                              },
                            },
                          },
                        },
                      },
                      {
                        entryId: 'user-2',
                        content: {
                          itemContent: {
                            user_results: {
                              result: {
                                __typename: 'User',
                                core: { screen_name: 'carol', name: 'Carol' },
                                legacy: { description: 'world', followers_count: 200 },
                              },
                            },
                          },
                        },
                      },
                      {
                        entryId: 'cursor-bottom-1',
                        content: {
                          entryType: 'TimelineTimelineCursor',
                          cursorType: 'Bottom',
                          value: 'next-cursor',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };
    const result = __test__.parseFollowing(payload);
    expect(result.users).toHaveLength(2);
    expect(result.users[0]).toMatchObject({ screen_name: 'bob', name: 'Bob', followers: 50 });
    expect(result.users[1]).toMatchObject({ screen_name: 'carol', name: 'Carol', followers: 200 });
    expect(result.nextCursor).toBe('next-cursor');
  });

  it('handles cursor-bottom entryId pattern', () => {
    const payload = {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  {
                    entries: [
                      {
                        entryId: 'cursor-bottom-0',
                        content: { itemContent: { value: 'cursor-val' } },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    };
    const result = __test__.parseFollowing(payload);
    expect(result.nextCursor).toBe('cursor-val');
    expect(result.users).toHaveLength(0);
  });

  it('returns empty users and null cursor for missing instructions', () => {
    const result = __test__.parseFollowing({ data: { user: { result: {} } } });
    expect(result.users).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('returns empty for completely empty payload', () => {
    const result = __test__.parseFollowing({});
    expect(result.users).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('normalizes screen names for CLI and profile-link inputs', () => {
    expect(__test__.normalizeScreenName('@elonmusk')).toBe('elonmusk');
    expect(__test__.normalizeScreenName('/elonmusk')).toBe('elonmusk');
    expect(__test__.normalizeScreenName('  @@alice  ')).toBe('alice');
    expect(__test__.normalizeScreenName('/home')).toBe('');
    expect(__test__.normalizeScreenName('/elonmusk/extra')).toBe('');
  });
});

function followingPayload(users: string[], cursor: string | null) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [
                {
                  entries: [
                    ...users.map((name) => ({
                      entryId: `user-${name}`,
                      content: {
                        itemContent: {
                          user_results: {
                            result: {
                              __typename: 'User',
                              core: { screen_name: name, name: name.toUpperCase() },
                              legacy: { description: `${name} bio`, followers_count: 10 },
                            },
                          },
                        },
                      },
                    })),
                    ...(cursor
                      ? [
                          {
                            entryId: `cursor-bottom-${cursor}`,
                            content: {
                              entryType: 'TimelineTimelineCursor',
                              cursorType: 'Bottom',
                              value: cursor,
                            },
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
          },
        },
      },
    },
  };
}

function bridgeEnvelope(data: unknown) {
  return { session: 'site:twitter', data };
}

function createFollowingPage(
  followingResponses: unknown[],
  {
    ct0 = 'token',
    userLookup = { userId: '42' } as unknown,
    envelope = false,
  }: { ct0?: string; userLookup?: unknown; envelope?: boolean } = {},
) {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn(async () => (ct0 ? [{ name: 'ct0', value: ct0 }] : [])),
    evaluate: vi.fn(async (script: unknown, ...args: unknown[]) => {
      const wrap = (value: unknown) => (envelope ? bridgeEnvelope(value) : value);
      if (typeof script === 'function') {
        const haystack = [
          (script as () => void).toString(),
          ...args.map((arg) => String(arg)),
        ].join('\n');
        if (haystack.includes('/UserByScreenName')) return wrap(userLookup);
        if (haystack.includes('/Following')) return wrap(followingResponses.shift() || followingPayload([], null));
        if (haystack.includes('AppTabBar_Profile_Link')) return wrap('/viewer');
        throw new Error(`Unexpected evaluate function: ${haystack.slice(0, 80)}`);
      }
      const s = String(script);
      if (s.includes('operationName')) return null;
      if (s.includes('/UserByScreenName')) return wrap(userLookup);
      if (s.includes('/Following')) return wrap(followingResponses.shift() || followingPayload([], null));
      if (s.includes('AppTabBar_Profile_Link')) return wrap('/viewer');
      throw new Error(`Unexpected evaluate script: ${s.slice(0, 80)}`);
    }),
  };
  return page;
}

describe('twitter following command (marketplace)', () => {
  const command = () => findAdapter('twitter', 'following');

  it('paginates with cursor, deduplicates users, strips @, and respects limit', async () => {
    const page = createFollowingPage([
      followingPayload(['alice', 'bob'], 'cursor-1'),
      followingPayload(['bob', 'carol', 'dave'], null),
    ]);

    const rows = (await command()!.func!(page, { user: '@elonmusk', limit: 3 })) as Array<{
      screen_name: string;
    }>;

    expect(rows.map((row) => row.screen_name)).toEqual(['alice', 'bob', 'carol']);
    expect(page.getCookies).toHaveBeenCalledWith({ url: 'https://x.com' });
    const callText = (call: unknown[]) =>
      call.map((part) => (typeof part === 'function' ? (part as () => void).toString() : String(part))).join('\n');
    const userLookupScript = callText(
      page.evaluate.mock.calls.find((call) => callText(call).includes('/UserByScreenName')) || [],
    );
    expect(decodeURIComponent(userLookupScript)).toContain('"screen_name":"elonmusk"');
    expect(decodeURIComponent(userLookupScript)).not.toContain('"screen_name":"@elonmusk"');
    const followingCalls = page.evaluate.mock.calls.filter((call) => callText(call).includes('/Following'));
    expect(followingCalls).toHaveLength(2);
    expect(decodeURIComponent(callText(followingCalls[1]))).toContain('"cursor":"cursor-1"');
  });

  it('rejects invalid limits before navigating', async () => {
    const page = createFollowingPage([]);
    await expect(command()!.func!(page, { user: 'elonmusk', limit: 0 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('rejects invalid explicit users before cookies or navigation', async () => {
    const page = createFollowingPage([]);
    await expect(command()!.func!(page, { user: 'elonmusk/extra', limit: 10 })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    expect(page.getCookies).not.toHaveBeenCalled();
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects route-like AppTabBar hrefs as AuthRequiredError', async () => {
    const page = createFollowingPage([]);
    page.evaluate.mockImplementation(async (script: unknown, ...args: unknown[]) => {
      const haystack = [
        typeof script === 'function' ? (script as () => void).toString() : String(script),
        ...args.map((arg) => String(arg)),
      ].join('\n');
      if (haystack.includes('AppTabBar_Profile_Link')) return '/home';
      throw new Error(`Unexpected evaluate: ${haystack.slice(0, 80)}`);
    });
    await expect(command()!.func!(page, { limit: 10 })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(page.goto).toHaveBeenCalledWith('https://x.com/home');
  });

  it('maps first-page auth failures to AuthRequiredError', async () => {
    const page = createFollowingPage([{ error: 401 }]);
    await expect(command()!.func!(page, { user: 'elonmusk', limit: 10 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('does not silently return partial rows when a later page fails', async () => {
    const page = createFollowingPage([followingPayload(['alice'], 'cursor-1'), { error: 429 }]);
    await expect(command()!.func!(page, { user: 'elonmusk', limit: 10 })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('maps user lookup auth failures to AuthRequiredError', async () => {
    const page = createFollowingPage([], { userLookup: { error: 403 } });
    await expect(command()!.func!(page, { user: 'elonmusk', limit: 10 })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('unwraps Browser Bridge envelopes for user lookup and following payloads', async () => {
    const page = createFollowingPage([followingPayload(['alice'], null)], { envelope: true });
    const rows = (await command()!.func!(page, { user: 'elonmusk', limit: 10 })) as Array<{
      screen_name: string;
    }>;
    expect(rows.map((row) => row.screen_name)).toEqual(['alice']);
    const callText = (call: unknown[]) =>
      call.map((part) => (typeof part === 'function' ? (part as () => void).toString() : String(part))).join('\n');
    const followingCall = page.evaluate.mock.calls.find((call) => callText(call).includes('/Following')) || [];
    const followingUrl = String(followingCall[1] || '');
    expect(decodeURIComponent(followingUrl)).toContain('"userId":"42"');
    expect(decodeURIComponent(followingUrl)).not.toContain('[object Object]');
  });

  it('fails fast when the following timeline is empty', async () => {
    const page = createFollowingPage([followingPayload([], null)]);
    await expect(command()!.func!(page, { user: 'elonmusk', limit: 10 })).rejects.toBeInstanceOf(
      EmptyResultError,
    );
  });

  it('surfaces the private-following privacy hint when result.timeline is empty', async () => {
    const page = createFollowingPage([{ data: { user: { result: { __typename: 'User', timeline: {} } } } }]);
    // opencli stored the hint in err.hint; our EmptyResultError folds it into message.
    await expect(command()!.func!(page, { user: 'simonw', limit: 10 })).rejects.toMatchObject({
      message: expect.stringContaining('following list to private'),
    });
  });
});
