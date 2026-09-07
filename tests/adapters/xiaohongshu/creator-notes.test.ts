/**
 * Port of opencli's clis/xiaohongshu/creator-notes.test.js.
 *
 * The bundled marketplace/xiaohongshu/creator-notes.js re-exports
 * `parseCreatorNotesText`, `parseCreatorNoteIdsFromHtml` and `__test__`
 * (harvestAnalyzeListCaptures / isAnalyzeCaptureComplete / parseCaptureMapPayload
 * / unwrapEvaluateResult), so all pure-helper tests are ported directly.
 *
 * The func tests drive the live closure through the page mock. Opencli's
 * `createPageMock(evaluateResult, interceptedRequests)` resolves `evaluate`
 * either from a single value (all calls) or — when given an array — the first
 * element then the LAST element forever (mirrored by setEvaluateSequence).
 * Two tests build a bespoke once-sequence to exercise the capture-incomplete
 * and empty-account paths.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError, EmptyResultError } from '@base/runtime/errors.js';
import {
  makeFakeXiaohongshuPage,
  setEvaluateOnceSequence,
  setEvaluateSequence,
} from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/creator-notes.js';
import {
  __test__,
  parseCreatorNoteIdsFromHtml,
  parseCreatorNotesText,
} from '../../../marketplace/xiaohongshu/creator-notes.js';

function createPageMock(evaluateResult: unknown, interceptedRequests: unknown[] = []) {
  const page = makeFakeXiaohongshuPage(interceptedRequests);
  if (Array.isArray(evaluateResult)) {
    setEvaluateSequence(page, evaluateResult);
  } else {
    page.evaluate.mockResolvedValue(evaluateResult);
  }
  return page;
}

describe('xiaohongshu/creator-notes (marketplace)', () => {
  const getCommand = () => findAdapter('xiaohongshu', 'creator-notes');

  it('parses creator note text blocks into rows', () => {
    const bodyText = `笔记管理
全部笔记(366)
已发布
测试笔记一
发布于 2025年12月04日 19:45
148208
324
2279
465
32
权限设置
取消置顶
编辑
删除
仅自己可见
测试笔记二
发布于 2026年03月18日 12:39
10
0
0
0
0
权限设置`;
    expect(parseCreatorNotesText(bodyText)).toEqual([
      {
        id: '',
        title: '测试笔记一',
        date: '2025年12月04日 19:45',
        views: 148208,
        likes: 2279,
        collects: 465,
        comments: 324,
        url: '',
      },
      {
        id: '',
        title: '测试笔记二',
        date: '2026年03月18日 12:39',
        views: 10,
        likes: 0,
        collects: 0,
        comments: 0,
        url: '',
      },
    ]);
  });

  it('reads body text and returns ranked rows', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([
      undefined,
      {
        text: `示例笔记
发布于 2026年03月19日 12:00
10
2
3
4
5
权限设置`,
        html: '&quot;noteId&quot;:&quot;aaaaaaaaaaaaaaaaaaaaaaaa&quot;',
      },
    ]);
    const result = await cmd!.func!(page, { limit: 1 });
    expect(page.evaluate.mock.calls.at(-1)?.[0]).toBe(
      '() => ({ text: document.body.innerText, html: document.body.innerHTML })',
    );
    expect(result).toEqual([
      {
        rank: 1,
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        title: '示例笔记',
        date: '2026年03月19日 12:00',
        views: 10,
        likes: 3,
        collects: 4,
        comments: 2,
        url: 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=aaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ]);
  });

  it('prefers note card dom data when the analyze api is unavailable', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([
      undefined,
      [
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          title: '测试笔记一',
          date: '2025年12月04日 19:45',
          metrics: [148284, 319, 2280, 466, 33],
        },
      ],
    ]);
    const result = await cmd!.func!(page, { limit: 1 });
    expect(result).toEqual([
      {
        rank: 1,
        id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        title: '测试笔记一',
        date: '2025年12月04日 19:45',
        views: 148284,
        likes: 2280,
        collects: 466,
        comments: 319,
        url: 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=bbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ]);
  });

  it('prefers the creator analyze API and preserves note ids', async () => {
    const cmd = getCommand();
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock(undefined, [
      {
        data: {
          note_infos: [
            {
              id: 'cccccccccccccccccccccccc',
              title: '示例内容复盘',
              post_time: new Date('2026-03-18T20:01:00+08:00').getTime(),
              read_count: 521,
              like_count: 18,
              fav_count: 10,
              comment_count: 7,
            },
          ],
        },
      },
    ]);
    const result = await cmd!.func!(page, { limit: 1 });
    expect(page.installInterceptor.mock.calls[0][0]).toContain(
      '/api/galaxy/creator/datacenter/note/analyze/list',
    );
    expect(result).toEqual([
      {
        rank: 1,
        id: 'cccccccccccccccccccccccc',
        title: '示例内容复盘',
        date: '2026年03月18日 20:01',
        views: 521,
        likes: 18,
        collects: 10,
        comments: 7,
        url: 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=cccccccccccccccccccccccc',
      },
    ]);
  });

  it('extracts note ids from creator note-manager html', () => {
    const html = `
      <div>&quot;noteId&quot;:&quot;aaaaaaaaaaaaaaaaaaaaaaaa&quot;</div>
      <div>&quot;noteId&quot;:&quot;dddddddddddddddddddddddd&quot;</div>
      <div>&quot;noteId&quot;:&quot;aaaaaaaaaaaaaaaaaaaaaaaa&quot;</div>
    `;
    expect(parseCreatorNoteIdsFromHtml(html)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      'dddddddddddddddddddddddd',
    ]);
  });

  it('harvests captured analyze pages in page order and dedupes note ids', () => {
    const captureMap = {
      '/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=2': {
        ok: true,
        body: JSON.stringify({
          data: {
            total: 3,
            note_infos: [
              { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: 'page 2' },
              { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'duplicate from page 2' },
            ],
          },
        }),
      },
      '/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1': {
        ok: true,
        body: JSON.stringify({
          data: {
            total: 3,
            note_infos: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'page 1' }],
          },
        }),
      },
    };
    expect(__test__.harvestAnalyzeListCaptures(captureMap)).toEqual({
      total: 3,
      items: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'page 1' },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', title: 'page 2' },
      ],
    });
  });

  it('treats incomplete captured pagination as fallback-needed instead of partial success', () => {
    const firstPageItems = Array.from({ length: 10 }, (_, index) => ({
      id: String(index).padStart(24, '0'),
    }));
    expect(__test__.isAnalyzeCaptureComplete(firstPageItems, 25, 20)).toBe(false);
    expect(__test__.isAnalyzeCaptureComplete(firstPageItems, 25, 10)).toBe(true);
    expect(__test__.isAnalyzeCaptureComplete(firstPageItems, 0, 20)).toBe(true);
  });

  it('unwraps browser bridge capture-map envelopes', () => {
    const captureMap = {
      '/api/galaxy/creator/datacenter/note/analyze/list?page_num=1': {
        ok: true,
        body: '{"data":{"total":0,"note_infos":[]}}',
      },
    };
    expect(
      __test__.parseCaptureMapPayload({ session: 'site:xiaohongshu', data: JSON.stringify(captureMap) }),
    ).toEqual(captureMap);
    expect(__test__.parseCaptureMapPayload({ session: 'site:xiaohongshu', data: captureMap })).toEqual(
      captureMap,
    );
  });

  it('does not fall back to partial DOM rows when captured total proves pagination is incomplete', async () => {
    const cmd = getCommand();
    const captureMap = {
      '/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1': {
        ok: true,
        body: JSON.stringify({
          data: {
            total: 25,
            note_infos: Array.from({ length: 10 }, (_, index) => ({
              id: String(index).padStart(24, '0'),
              title: `note ${index}`,
            })),
          },
        }),
      },
    };
    const page = makeFakeXiaohongshuPage();
    setEvaluateOnceSequence(page, [
      undefined,
      undefined,
      JSON.stringify(captureMap),
      false,
    ]);

    await expect(cmd!.func!(page, { limit: 20 })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('throws EmptyResultError when the creator account has no notes', async () => {
    const cmd = getCommand();
    const page = makeFakeXiaohongshuPage();
    setEvaluateOnceSequence(page, [undefined, undefined, [], { text: '', html: '' }]);

    await expect(cmd!.func!(page, { limit: 1 })).rejects.toBeInstanceOf(EmptyResultError);
  });
});
