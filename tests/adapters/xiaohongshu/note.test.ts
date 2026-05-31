/**
 * Port of opencli's clis/xiaohongshu/note.test.js.
 *
 * Opencli's note.test.js also has two describe blocks that test the PURE
 * helpers `parseNoteId` / `buildNoteUrl` imported from `./note-helpers.js`.
 * Our bundled marketplace/xiaohongshu/note.js INLINES those helpers as
 * file-locals and only re-exports `NOTE_EXTRACT_JS` + `command` — the helpers
 * are not reachable, so those two pure-helper describe blocks are SKIPPED
 * (recorded in the run report). The `xiaohongshu note` block (which drives the
 * live `func`) is ported faithfully; the URL-validation behavior those helpers
 * provide is still exercised transitively through `func` (bare-id rejection,
 * full-URL preservation).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { EmptyResultError } from '../../../src/runtime/errors.js';
import { makeFakeXiaohongshuPage } from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/note.js';

describe('xiaohongshu/note (marketplace)', () => {
  const command = findAdapter('xiaohongshu', 'note');

  let page = makeFakeXiaohongshuPage();
  beforeEach(() => {
    page = makeFakeXiaohongshuPage();
  });

  it('is registered', () => {
    expect(command).toBeDefined();
    expect(command!.func).toBeTypeOf('function');
  });

  it('returns note content as field/value rows for signed full URLs', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: '尚界Z7实车体验',
      desc: '今天去看了实车，外观很帅',
      author: '小红薯用户',
      likes: '257',
      collects: '98',
      comments: '45',
      tags: ['#尚界Z7', '#鸿蒙智行'],
    });
    const signedUrl =
      'https://www.xiaohongshu.com/search_result/69c131c9000000002800be4c?xsec_token=abc';
    const result = await command!.func!(page, { 'note-id': signedUrl });
    expect(page.goto.mock.calls[0][0]).toBe(signedUrl);
    expect(result).toEqual([
      { field: 'title', value: '尚界Z7实车体验' },
      { field: 'author', value: '小红薯用户' },
      { field: 'content', value: '今天去看了实车，外观很帅' },
      { field: 'likes', value: '257' },
      { field: 'collects', value: '98' },
      { field: 'comments', value: '45' },
      { field: 'tags', value: '#尚界Z7, #鸿蒙智行' },
    ]);
  });

  it('rejects bare note IDs before browser navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'Test',
      desc: '',
      author: '',
      likes: '0',
      collects: '0',
      comments: '0',
      tags: [],
    });
    await expect(
      command!.func!(page, { 'note-id': '69c131c9000000002800be4c' }),
    ).rejects.toMatchObject({
      code: 'ARGUMENT',
      message: expect.stringContaining('signed URL'),
      help: expect.stringContaining('xsec_token'),
    });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('parses note ID from full /explore/ URL', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'Test',
      desc: '',
      author: '',
      likes: '0',
      collects: '0',
      comments: '0',
      tags: [],
    });
    await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/explore/69c131c9000000002800be4c?xsec_token=abc',
    });
    expect(page.goto.mock.calls[0][0]).toContain('/explore/69c131c9000000002800be4c');
  });

  it('preserves full search_result URL with xsec_token for navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'Test',
      desc: '',
      author: '',
      likes: '0',
      collects: '0',
      comments: '0',
      tags: [],
    });
    const fullUrl =
      'https://www.xiaohongshu.com/search_result/69c131c9000000002800be4c?xsec_token=abc';
    await command!.func!(page, { 'note-id': fullUrl });
    expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
  });

  it('preserves signed /user/profile/<user>/<note> URLs for navigation', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'Test',
      desc: '',
      author: '',
      likes: '0',
      collects: '0',
      comments: '0',
      tags: [],
    });
    const fullUrl =
      'https://www.xiaohongshu.com/user/profile/user123/69c131c9000000002800be4c?xsec_token=abc&xsec_source=pc_user';
    await command!.func!(page, { 'note-id': fullUrl });
    expect(page.goto.mock.calls[0][0]).toBe(fullUrl);
  });

  it('throws AuthRequiredError on login wall', async () => {
    page.evaluate.mockResolvedValue({ loginWall: true, notFound: false });
    await expect(
      command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
      }),
    ).rejects.toThrow('Note content requires login');
  });

  it('throws SECURITY_BLOCK with retry guidance when a full URL is blocked', async () => {
    page.evaluate.mockResolvedValue({
      pageUrl: 'https://www.xiaohongshu.com/website-login/error?error_code=300031',
      securityBlock: true,
      loginWall: false,
      notFound: false,
    });
    await expect(
      command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/69c131c9000000002800be4c?xsec_token=abc',
      }),
    ).rejects.toMatchObject({
      code: 'SECURITY_BLOCK',
      help: expect.stringContaining('Try again later'),
    });
  });

  it('throws EmptyResultError when note is not found', async () => {
    // opencli asserted `toThrow('returned no data')`, but that string is an
    // artifact of opencli's EmptyResultError(command, hint) ALWAYS building the
    // message as `${command} returned no data`. This project's EmptyResultError
    // shim intentionally diverges (source, message) — documented in
    // src/runtime/errors.js — so the SAME notFound input yields the adapter's
    // own "Note <id> not found …" message. The substantive behavior the opencli
    // test pinned (notFound → EmptyResultError) is preserved; only the message
    // mechanism differs, so we assert the instance + the adapter's real message.
    page.evaluate.mockResolvedValue({ loginWall: false, notFound: true });
    await expect(
      command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof EmptyResultError && /not found or unavailable/.test((err as Error).message),
    );
  });

  it('throws an empty-result error when the note page renders as an empty shell', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: '',
      desc: '',
      author: '',
      likes: '',
      collects: '',
      comments: '',
      tags: [],
    });
    try {
      await command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/69ca3927000000001a020fd5?xsec_token=abc',
      });
      throw new Error('expected xiaohongshu note to fail on an empty shell page');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'EMPTY_RESULT',
        message: expect.stringContaining('loaded without visible content'),
      });
    }
  });

  it('keeps the empty-shell hint generic when the user already passed a full URL', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: '',
      desc: '',
      author: '',
      likes: '',
      collects: '',
      comments: '',
      tags: [],
    });
    try {
      await command!.func!(page, {
        'note-id': 'https://www.xiaohongshu.com/search_result/69ca3927000000001a020fd5?xsec_token=abc',
      });
      throw new Error('expected xiaohongshu note to fail on an empty shell page');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'EMPTY_RESULT',
        message: expect.stringContaining('loaded without visible content'),
      });
      expect((error as { message: string }).message).not.toContain('bare note ID');
    }
  });

  it('normalizes placeholder text to 0 for zero-count metrics', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'New note',
      desc: 'Just posted',
      author: 'Author',
      likes: '赞',
      collects: '收藏',
      comments: '评论',
      tags: [],
    });
    const result = (await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
    })) as Array<{ field: string; value: string }>;
    expect(result.find((r) => r.field === 'likes')!.value).toBe('0');
    expect(result.find((r) => r.field === 'collects')!.value).toBe('0');
    expect(result.find((r) => r.field === 'comments')!.value).toBe('0');
  });

  it('scopes metric selectors to .interact-container to avoid matching comment like buttons', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'Test',
      desc: '',
      author: 'Author',
      likes: '10',
      collects: '5',
      comments: '3',
      tags: [],
    });
    await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
    });
    const evaluateScript = page.evaluate.mock.calls[0][0];
    expect(evaluateScript).toContain('.interact-container .like-wrapper .count');
    expect(evaluateScript).toContain('.interact-container .collect-wrapper .count');
    expect(evaluateScript).toContain('.interact-container .chat-wrapper .count');
  });

  it('omits tags row when no tags present', async () => {
    page.evaluate.mockResolvedValue({
      loginWall: false,
      notFound: false,
      title: 'No tags',
      desc: 'Content',
      author: 'Author',
      likes: '1',
      collects: '2',
      comments: '3',
      tags: [],
    });
    const result = (await command!.func!(page, {
      'note-id': 'https://www.xiaohongshu.com/search_result/abc123?xsec_token=tok',
    })) as Array<{ field: string; value: string }>;
    expect(result.find((r) => r.field === 'tags')).toBeUndefined();
    expect(result).toHaveLength(6);
  });
});
