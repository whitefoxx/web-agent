/**
 * Port of opencli's clis/bilibili/summary.test.js.
 *
 * The b23.tv short-link test exercises the inlined resolveBvid path that calls
 * https.get(); we mock 'node:https' at file scope so that one test can drive
 * the redirect Location → BV extraction. Other tests use BV inputs or
 * non-bilibili URLs that fall through resolveBvid's pure-regex branches and
 * never hit https.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import { makeFakeBilibiliPage } from '../_helpers/bilibili-page.js';

// Stub https.get for the b23.tv redirect path inside the bundled adapter.
// Each test that needs a specific redirect sets `nextLocation`; tests that
// don't touch b23.tv never invoke this and don't care.
let nextLocation: string | undefined;
vi.mock('node:https', () => ({
  default: {
    get: vi.fn((_url: string, cb: (res: unknown) => void) => {
      const res = {
        headers: { location: nextLocation },
        resume: () => {},
      };
      queueMicrotask(() => cb(res));
      return {
        on: () => {},
        setTimeout: () => {},
        destroy: () => {},
      };
    }),
  },
}));

import '../../../marketplace/bilibili/summary.js';

describe('bilibili/summary (marketplace)', () => {
  const command = findAdapter('bilibili', 'summary');
  let page = makeFakeBilibiliPage();

  beforeEach(() => {
    page = makeFakeBilibiliPage();
    nextLocation = undefined;
  });

  function mockView(data = { aid: 114, cid: 222, owner: { mid: 333 } }) {
    page.apiGet.mockResolvedValueOnce({ code: 0, data });
  }

  function mockConclusion(modelResult: unknown) {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { code: 0, model_result: modelResult },
    });
  }

  it('returns the summary plus timestamped outline rows', async () => {
    mockView();
    mockConclusion({
      summary: '整体总结',
      outline: [
        {
          title: '第一节',
          timestamp: 0,
          part_outline: [
            { timestamp: 12, content: '要点A' },
            { timestamp: 3725, content: '要点B' },
          ],
        },
      ],
    });

    const result = await command!.func!(page, { bvid: 'BV1xxx' });

    expect(page.apiGet).toHaveBeenNthCalledWith(1, page, '/x/web-interface/view', {
      params: { bvid: 'BV1xxx' },
    });
    expect(page.apiGet).toHaveBeenNthCalledWith(2, page, '/x/web-interface/view/conclusion/get', {
      params: { bvid: 'BV1xxx', cid: '222', up_mid: '333' },
      signed: true,
    });
    expect(result).toEqual([
      { time: '', content: '整体总结' },
      { time: '00:00', content: '# 第一节' },
      { time: '00:12', content: '要点A' },
      { time: '1:02:05', content: '要点B' },
    ]);
  });

  it('returns just the summary when the video has no outline', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion({ summary: '只有总结', outline: [] });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).resolves.toEqual([
      { time: '', content: '只有总结' },
    ]);
  });

  it('parses model_result when Bilibili returns it as a JSON string', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion(JSON.stringify({ summary: '字符串总结', outline: [] }));

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).resolves.toEqual([
      { time: '', content: '字符串总结' },
    ]);
  });

  it('normalizes Bilibili video URLs before calling the APIs', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion({ summary: 'URL 总结', outline: [] });

    await command!.func!(page, {
      bvid: 'https://www.bilibili.com/video/BV1abc12345/?spm_id_from=333.1007',
    });

    expect(page.apiGet).toHaveBeenNthCalledWith(1, page, '/x/web-interface/view', {
      params: { bvid: 'BV1abc12345' },
    });
  });

  it('resolves b23.tv short links through the shared resolver', async () => {
    nextLocation = '/video/BVshort12345';
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion({ summary: '短链总结', outline: [] });

    await command!.func!(page, { bvid: 'https://b23.tv/abc' });

    expect(page.apiGet).toHaveBeenNthCalledWith(1, page, '/x/web-interface/view', {
      params: { bvid: 'BVshort12345' },
    });
  });

  it('rejects invalid inputs before calling Bilibili APIs', async () => {
    const cases = [
      '',
      'javascript:alert(1)',
      'https://example.com/video/BV1abc12345',
      'https://share.note.youdao.com/video/BV1abc12345',
      'https://www.bilibili.com/read/cv12345',
    ];

    for (const bvid of cases) {
      await expect(command!.func!(page, { bvid })).rejects.toBeInstanceOf(ArgumentError);
    }
    expect(page.apiGet).not.toHaveBeenCalled();
  });

  it('maps unresolved short-code inputs to ArgumentError without calling APIs', async () => {
    await expect(command!.func!(page, { bvid: 'not-a-bv' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.apiGet).not.toHaveBeenCalled();
  });

  it('throws EmptyResultError when Bilibili has not generated an AI summary for the video', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    page.apiGet.mockResolvedValueOnce({ code: 0, data: { code: 1, model_result: {} } });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('throws CommandExecutionError when the view payload is malformed', async () => {
    page.apiGet.mockResolvedValueOnce({ code: 0, data: {} });

    await expect(command!.func!(page, { bvid: 'BVbroken' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /cid\/up_mid/.test((err as Error).message),
    );
  });

  it('throws CommandExecutionError when the view API returns a non-auth error', async () => {
    page.apiGet.mockResolvedValueOnce({ code: -404, message: '啥都木有' });

    await expect(command!.func!(page, { bvid: 'BVbroken' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /啥都木有.*-404/.test((err as Error).message),
    );
  });

  it('maps conclusion auth or permission errors to AuthRequiredError', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    page.apiGet.mockResolvedValueOnce({ code: -403, message: '访问权限不足' });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('maps conclusion non-auth API errors to CommandExecutionError', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    page.apiGet.mockResolvedValueOnce({ code: -500, message: 'server error' });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /server error.*-500/.test((err as Error).message),
    );
  });

  it('throws CommandExecutionError for malformed conclusion API payloads', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    page.apiGet.mockResolvedValueOnce(null);

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('throws CommandExecutionError for malformed model_result JSON', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion('{bad json');

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /model_result JSON/.test((err as Error).message),
    );
  });

  it('throws CommandExecutionError for malformed outline shapes', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion({ summary: '坏 outline', outline: {} });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /outline/.test((err as Error).message),
    );
  });

  it('throws CommandExecutionError for malformed part outline shapes', async () => {
    mockView({ aid: 1, cid: 2, owner: { mid: 3 } });
    mockConclusion({
      summary: '坏 part_outline',
      outline: [{ title: '段落', timestamp: 0, part_outline: {} }],
    });

    await expect(command!.func!(page, { bvid: 'BV1xxx' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /part outline/.test((err as Error).message),
    );
  });
});
