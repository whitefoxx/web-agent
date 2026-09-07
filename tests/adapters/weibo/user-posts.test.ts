/**
 * Port of opencli's clis/weibo/user-posts.test.js.
 *
 * The bundled adapter does all its work in one `page.evaluate(<async fetch
 * script>)` returning either a `[uid, rows, sawList, sawPostCandidates]`
 * tuple or an `{ error }` object (optionally wrapped in a `{ session, data }`
 * browser-bridge envelope). Opencli seeds that single evaluate via
 * `makePage(payload)`; we reuse `makeFixedPage` for the same seam.
 *
 * `testInternals.dateToTimestamp` is re-exported by the bundled file (the
 * inlined helper survives the esbuild bundle), so the date-boundary test
 * ports verbatim. Only the registry lookup and error imports change per the
 * port cheatsheet.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@base/runtime/errors.js';
import { makeFixedPage } from '../_helpers/weibo-page.js';

import '../../../marketplace/weibo/user-posts.js';
import { testInternals } from '../../../marketplace/weibo/user-posts.js';

function envelope(data: unknown) {
  return { session: 'site:weibo:test', data };
}

describe('weibo user-posts (marketplace)', () => {
  const command = findAdapter('weibo', 'user-posts');

  it('validates id, limit, dates, and date ranges before navigation', async () => {
    await expect(
      command!.func!(makeFixedPage({ rows: [] }), { id: '', limit: 10 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    await expect(
      command!.func!(makeFixedPage({ rows: [] }), { id: '123', limit: 0 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    await expect(
      command!.func!(makeFixedPage({ rows: [] }), { id: '123', start: '2025-02-30', limit: 10 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    await expect(
      command!.func!(makeFixedPage({ rows: [] }), {
        id: '123',
        start: '2025-06-02',
        end: '2025-06-01',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(ArgumentError);
  });

  it('converts Asia/Shanghai date boundaries to unix seconds', () => {
    expect(testInternals.dateToTimestamp('2025-06-01')).toBe(1748707200);
    expect(testInternals.dateToTimestamp('2025-01-01')).toBe(1735660800);
  });

  it('unwraps browser bridge envelopes and returns stable listing rows', async () => {
    const page = makeFixedPage(
      envelope([
        '1670458304',
        [
          {
            id: '5012345678901234',
            mblogid: 'QD5uq0ydj',
            author: 'Alice',
            uid: '1670458304',
            text: 'hello',
            time: 'Sun Jun 01 10:00:00 +0800 2025',
            reposts: 1,
            comments: 2,
            likes: 3,
            pic_count: 4,
            url: 'https://weibo.com/1670458304/QD5uq0ydj',
          },
        ],
        true,
        true,
      ]),
    );

    await expect(
      command!.func!(page, {
        id: '1670458304',
        start: '2025-06-01',
        end: '2025-06-02',
        limit: 20,
      }),
    ).resolves.toEqual([
      {
        rank: 1,
        id: '5012345678901234',
        mblogid: 'QD5uq0ydj',
        author: 'Alice',
        uid: '1670458304',
        text: 'hello',
        time: 'Sun Jun 01 10:00:00 +0800 2025',
        reposts: 1,
        comments: 2,
        likes: 3,
        pic_count: 4,
        url: 'https://weibo.com/1670458304/QD5uq0ydj',
      },
    ]);
  });

  it('maps auth-like evaluate errors to AuthRequiredError', async () => {
    await expect(
      command!.func!(makeFixedPage({ error: 'login required: HTTP 403' }), {
        id: '123',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('maps malformed payload and parser drift to CommandExecutionError', async () => {
    await expect(
      command!.func!(makeFixedPage({ rows: [] }), { id: '123', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(
      command!.func!(
        makeFixedPage({ error: 'Weibo user posts response did not include data.list' }),
        { id: '123', limit: 10 },
      ),
    ).rejects.toBeInstanceOf(CommandExecutionError);
    await expect(
      command!.func!(makeFixedPage(['123', [], true, true]), { id: '123', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('maps true empty lists to EmptyResultError', async () => {
    await expect(
      command!.func!(makeFixedPage(['123', [], true, false]), { id: '123', limit: 10 }),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });
});
