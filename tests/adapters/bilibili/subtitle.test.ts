/**
 * Port of opencli's clis/bilibili/subtitle.test.js.
 *
 * Subtitle file fetch goes through `page.evaluate(<script with fetch(url)>)`
 * where the URL is bound to a var (not a literal). The fake page's router
 * doesn't see a literal api.bilibili.com URL → falls through to
 * `page.directEvaluate`, which the tests mock for canned subtitle payloads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import { makeFakeBilibiliPage } from '../_helpers/bilibili-page.js';

import '../../../marketplace/bilibili/subtitle.js';

describe('bilibili/subtitle (marketplace)', () => {
  const command = findAdapter('bilibili', 'subtitle');
  let page = makeFakeBilibiliPage();

  beforeEach(() => {
    page = makeFakeBilibiliPage();
  });

  // view (first apiGet) returns OK with cid
  const mockViewOk = (cid = 123456) =>
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { bvid: 'BV1GbXPBeEZm', cid } });

  it('throws AuthRequiredError when bilibili hides subtitles behind login', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { need_login_subtitle: true, subtitle: { subtitles: [] } },
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof AuthRequiredError && /login|登录/i.test((err as Error).message),
    );
  });

  it('throws EmptyResultError when a video truly has no subtitles', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { need_login_subtitle: false, subtitle: { subtitles: [] } },
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(EmptyResultError);
  });

  it('throws CommandExecutionError when view API returns non-zero code', async () => {
    page.apiGet.mockResolvedValueOnce({ code: -404, message: '啥都木有' });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('wraps view API fetch/json exceptions as CommandExecutionError', async () => {
    page.apiGet.mockRejectedValueOnce(new SyntaxError('Unexpected token <'));
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('throws CommandExecutionError when view API succeeds but lacks cid', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { bvid: 'BV1GbXPBeEZm' } });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(/cid/);
  });

  it('throws CommandExecutionError when player subtitle payload is malformed', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { need_login_subtitle: false, subtitle: { subtitles: { lan: 'zh-CN' } } },
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('throws CommandExecutionError when player API returns a non-object payload', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce(null);
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );

    page = makeFakeBilibiliPage();
    mockViewOk();
    page.apiGet.mockResolvedValueOnce([]);
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('throws AuthRequiredError only for explicit empty subtitle_url entries', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '' }] },
      },
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(AuthRequiredError);
  });

  it('throws CommandExecutionError when subtitle entry lacks subtitle_url field', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN' }] },
      },
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('wraps subtitle file fetch exceptions as CommandExecutionError', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//example.com/sub.json' }] },
      },
    });
    page.directEvaluate.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('throws EmptyResultError when subtitle file has no cue rows', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//example.com/sub.json' }] },
      },
    });
    page.directEvaluate.mockResolvedValueOnce({ success: true, data: [] });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(EmptyResultError);
  });

  it('throws CommandExecutionError when subtitle cue rows have malformed time ranges', async () => {
    mockViewOk();
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//example.com/sub.json' }] },
      },
    });
    page.directEvaluate.mockResolvedValueOnce({
      success: true,
      data: [{ from: 'bad', to: 1.5, content: 'hello' }],
    });
    await expect(command!.func!(page, { bvid: 'BV1GbXPBeEZm' })).rejects.toThrow(
      CommandExecutionError,
    );
  });

  it('works for bangumi-bound bvid (PGC content) — same code path, view API returns cid + redirect_url', async () => {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        bvid: 'BV1Py4y1D781',
        cid: 267270412,
        redirect_url: 'https://www.bilibili.com/bangumi/play/ep371508',
        title: '【纪录片】灭绝的真相',
      },
    });
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        need_login_subtitle: false,
        subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//example.com/sub.json' }] },
      },
    });
    page.directEvaluate.mockResolvedValueOnce({
      success: true,
      data: [
        { from: 0, to: 1.5, content: 'hello' },
        { from: 1.5, to: 3.2, content: 'world' },
      ],
    });
    const out = await command!.func!(page, { bvid: 'BV1Py4y1D781' });
    expect(out).toEqual([
      { index: 1, from: '0.00s', to: '1.50s', content: 'hello' },
      { index: 2, from: '1.50s', to: '3.20s', content: 'world' },
    ]);
    expect(page.goto).not.toHaveBeenCalled();
    const firstCall = page.apiGet.mock.calls[0];
    expect(firstCall[1]).toBe('/x/web-interface/view');
    expect(firstCall[2]?.params?.bvid).toBe('BV1Py4y1D781');
  });
});
