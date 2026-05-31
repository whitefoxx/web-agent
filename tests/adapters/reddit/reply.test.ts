/**
 * Port of opencli's clis/reddit/reply.test.js.
 *
 * reply is a FUNC adapter. Pure helpers (normalizeRedditCommentFullname /
 * requireReplyText) are re-exported by the bundled file, so we import them
 * straight from there. The `evaluate` envelope is canned via
 * makeFakeRedditPage (opencli's makePage). Lookup + error imports swapped.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
} from '../../../src/runtime/errors.js';
import { makeFakeRedditPage } from '../_helpers/reddit-page.js';

import {
  normalizeRedditCommentFullname,
  requireReplyText,
} from '../../../marketplace/reddit/reply.js';
import '../../../marketplace/reddit/reply.js';

const OK_RESULT = { kind: 'ok', detail: 'Reply posted on t1_okf3s7u as t1_reply123' };

describe('reddit reply command (marketplace)', () => {
  const command = findAdapter('reddit', 'reply');

  it('normalizes bare ids, fullnames, and exact reddit comment URLs', () => {
    expect(normalizeRedditCommentFullname('okf3s7u')).toBe('t1_okf3s7u');
    expect(normalizeRedditCommentFullname('T1_OKF3S7U')).toBe('t1_okf3s7u');
    expect(normalizeRedditCommentFullname('https://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/?context=3')).toBe('t1_okf3s7u');
    expect(normalizeRedditCommentFullname('https://old.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/')).toBe('t1_okf3s7u');
  });

  it('rejects invalid or ambiguous comment identities before navigation', async () => {
    const page = makeFakeRedditPage(OK_RESULT);

    for (const value of [
      '',
      't3_1abc23',
      'abc/def',
      'https://reddit.com.evil.com/r/opencli/comments/1abc23/title_slug/okf3s7u/',
      'http://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/',
      'https://www.reddit.com/r/opencli/comments/1abc23/title_slug/',
      'https://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/evil',
    ]) {
      await expect(command!.func!(page, { 'comment-id': value, text: 'hello' })).rejects.toBeInstanceOf(ArgumentError);
    }

    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('rejects blank reply text before navigation', async () => {
    const page = makeFakeRedditPage(OK_RESULT);

    await expect(command!.func!(page, { 'comment-id': 'okf3s7u', text: '   ' })).rejects.toBeInstanceOf(ArgumentError);

    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(() => requireReplyText('hello')).not.toThrow();
  });

  it('posts to the normalized t1 fullname and returns success only on ok result', async () => {
    const page = makeFakeRedditPage(OK_RESULT);

    const rows = await command!.func!(page, {
      'comment-id': 'https://www.reddit.com/r/opencli/comments/1abc23/title_slug/okf3s7u/',
      text: 'hello',
    });

    expect(page.goto).toHaveBeenCalledWith('https://www.reddit.com');
    const script = page.evaluate.mock.calls[0][0];
    expect(script).toContain('const fullname = "t1_okf3s7u"');
    expect(script).toContain('const text = "hello"');
    expect(rows).toEqual([{ status: 'success', message: 'Reply posted on t1_okf3s7u as t1_reply123' }]);
  });

  it('maps auth, http, reddit, exception, and postcondition failures to typed errors', async () => {
    await expect(command!.func!(makeFakeRedditPage({ kind: 'auth', detail: 'login required' }), { 'comment-id': 'okf3s7u', text: 'hello' }))
      .rejects.toBeInstanceOf(AuthRequiredError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'http', httpStatus: 500, where: '/api/comment' }), { 'comment-id': 'okf3s7u', text: 'hello' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'reddit-error', detail: 'RATELIMIT: try later' }), { 'comment-id': 'okf3s7u', text: 'hello' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'exception', detail: 'bad json' }), { 'comment-id': 'okf3s7u', text: 'hello' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
    await expect(command!.func!(makeFakeRedditPage({ kind: 'postcondition', detail: 'Reddit comment response did not include a created reply id' }), { 'comment-id': 'okf3s7u', text: 'hello' }))
      .rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('requires the Reddit response to include a created reply id', async () => {
    const page = makeFakeRedditPage(OK_RESULT);

    await command!.func!(page, { 'comment-id': 'okf3s7u', text: 'hello' });

    expect(page.evaluate.mock.calls[0][0]).toContain('Reddit comment response did not include a created reply id');
    expect(page.evaluate.mock.calls[0][0]).toContain("String(thing?.data?.name || '').startsWith('t1_')");
  });
});
