/**
 * Port of opencli's clis/bilibili/comment.test.js.
 *
 * Mention resolution: the bundled adapter resolves @username via the inlined
 * resolveUid, which calls /x/web-interface/wbi/search/type. We mock that with
 * a second apiGet (signed). Opencli mocked resolveUid directly; we mock at
 * the underlying HTTP layer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
} from '../../../src/runtime/errors.js';
import { makeFakeBilibiliPage } from '../_helpers/bilibili-page.js';

import '../../../marketplace/bilibili/comment.js';

describe('bilibili/comment (marketplace)', () => {
  const command = findAdapter('bilibili', 'comment');
  let page = makeFakeBilibiliPage();

  beforeEach(() => {
    page = makeFakeBilibiliPage();
  });

  it('refuses to post without --execute', async () => {
    await expect(command!.func!(page, { bvid: 'BV1WtAGzYEBm', message: 'hi' })).rejects.toThrow(
      /--execute/,
    );
    expect(page.apiPost).not.toHaveBeenCalled();
  });

  it('rejects an empty message before calling the API', async () => {
    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: '   ', execute: true }),
    ).rejects.toThrow(/empty/i);
    expect(page.apiGet).not.toHaveBeenCalled();
  });

  it('posts a top-level comment, resolving @mentions to at_name_to_mid', async () => {
    page.apiGet
      .mockResolvedValueOnce({ code: 0, data: { aid: 12345 } }) // view
      .mockResolvedValueOnce({ code: 0, data: { result: [{ mid: 1141159409 }] } }); // user search
    page.apiPost.mockResolvedValueOnce({ code: 0, data: { rpid: 99887766 } });

    const result = await command!.func!(page, {
      bvid: 'BV1WtAGzYEBm',
      message: '@AI视频小助理 总结一下',
      execute: true,
    });

    expect(page.apiGet).toHaveBeenNthCalledWith(1, page, '/x/web-interface/view', {
      params: { bvid: 'BV1WtAGzYEBm' },
    });
    // resolveUid sends a wbi-signed user-search request
    expect(page.apiGet).toHaveBeenNthCalledWith(2, page, '/x/web-interface/wbi/search/type', {
      params: { search_type: 'bili_user', keyword: 'AI视频小助理' },
      signed: true,
    });
    expect(page.apiPost).toHaveBeenCalledWith(page, '/x/v2/reply/add', {
      params: {
        oid: '12345',
        type: '1',
        message: '@AI视频小助理 总结一下',
        plat: '1',
        at_name_to_mid: '{"AI视频小助理":1141159409}',
      },
    });
    expect(result).toEqual([
      {
        rpid: '99887766',
        bvid: 'BV1WtAGzYEBm',
        oid: '12345',
        message: '@AI视频小助理 总结一下',
        url: 'https://www.bilibili.com/video/BV1WtAGzYEBm#reply99887766',
      },
    ]);
  });

  it('still posts when an @mention cannot be resolved, leaving it as plain text', async () => {
    page.apiGet
      .mockResolvedValueOnce({ code: 0, data: { aid: 7 } }) // view
      .mockResolvedValueOnce({ code: 0, data: { result: [] } }); // empty user search → EmptyResultError, swallowed by adapter
    page.apiPost.mockResolvedValueOnce({ code: 0, data: { rpid: 5 } });

    await command!.func!(page, { bvid: 'BV1xxx', message: '@幽灵用户zzz hi', execute: true });

    expect(page.apiPost).toHaveBeenCalledWith(page, '/x/v2/reply/add', {
      params: { oid: '7', type: '1', message: '@幽灵用户zzz hi', plat: '1' },
    });
  });

  it('fails closed when mention resolution has parser or transport errors', async () => {
    page.apiGet
      .mockResolvedValueOnce({ code: 0, data: { aid: 7 } }) // view
      .mockRejectedValueOnce(new CommandExecutionError('search API drift'));

    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: '@用户 hi', execute: true }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.apiPost).not.toHaveBeenCalled();
  });

  it('fails closed when mention resolution returns a malformed mid', async () => {
    page.apiGet
      .mockResolvedValueOnce({ code: 0, data: { aid: 7 } }) // view
      .mockResolvedValueOnce({ code: 0, data: { result: [{ mid: 'not-a-mid' }] } });

    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: '@用户 hi', execute: true }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
    expect(page.apiPost).not.toHaveBeenCalled();
  });

  it('posts a reply under an existing comment when --parent is given', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { aid: 1 } });
    page.apiPost.mockResolvedValueOnce({ code: 0, data: { rpid: 2 } });

    await command!.func!(page, { bvid: 'BV1xxx', message: 'thanks', parent: 555, execute: true });

    expect(page.apiPost).toHaveBeenCalledWith(page, '/x/v2/reply/add', {
      params: {
        oid: '1',
        type: '1',
        message: 'thanks',
        plat: '1',
        root: '555',
        parent: '555',
      },
    });
  });

  it('throws when the bvid cannot be resolved to an aid', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: {} });
    await expect(
      command!.func!(page, { bvid: 'BVbroken', message: 'hi', execute: true }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('throws with the API code and message when Bilibili rejects the comment', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { aid: 9 } });
    page.apiPost.mockResolvedValueOnce({ code: 12025, message: '评论字数过多' });
    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: 'x', execute: true }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('maps login/csrf failures from the write API to AuthRequiredError', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { aid: 9 } });
    page.apiPost.mockResolvedValueOnce({ code: -111, message: 'csrf 校验失败' });
    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: 'x', execute: true }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('rejects invalid parent ids before posting', async () => {
    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: 'x', parent: 0, execute: true }),
    ).rejects.toBeInstanceOf(ArgumentError);
    expect(page.apiGet).not.toHaveBeenCalled();
    expect(page.apiPost).not.toHaveBeenCalled();
  });

  it('fails closed when the write API omits rpid', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { aid: 9 } });
    page.apiPost.mockResolvedValueOnce({ code: 0, data: {} });
    await expect(
      command!.func!(page, { bvid: 'BV1xxx', message: 'x', execute: true }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });
});
