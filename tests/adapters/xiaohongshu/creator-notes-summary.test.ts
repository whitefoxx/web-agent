/**
 * Port of opencli's clis/xiaohongshu/creator-notes-summary.test.js.
 *
 * IMPORTANT DIVERGENCE (mechanism only, behavior preserved):
 *   opencli's tests 2 & 3 mock the cross-module imports with
 *     vi.spyOn(creatorNotesModule, 'fetchCreatorNotes')
 *     vi.spyOn(creatorDetailModule, 'fetchCreatorNoteDetailRows')
 *   Our bundled marketplace/xiaohongshu/creator-notes-summary.js is a SINGLE
 *   esbuild bundle that INLINES creator-notes.js + creator-note-detail.js +
 *   creator-notes-summary.js — there is NO `./creator-notes.js` module boundary,
 *   so `fetchCreatorNotes` / `fetchCreatorNoteDetailRows` are file-local closures
 *   the summary's `func` calls directly. vi.spyOn on a separate module cannot
 *   intercept them. We therefore drive the SAME observable behavior through the
 *   real `page` seam (the only boundary the bundle actually crosses):
 *     - test 2 (waits between notes): a stateful script-content router makes the
 *       inlined capture path yield 2  id-bearing notes, and the inlined detail
 *       path yield detail rows, so the summary loop runs `page.wait` exactly once.
 *     - test 3 (no notes → EmptyResultError): an evaluate sequence that makes all
 *       inlined fetch paths return [] (capture empty, api empty, dom empty).
 *   The substantive assertions (one wait call with a { time } arg; EmptyResultError)
 *   are preserved verbatim.
 *
 * Test 1 (`summarizeCreatorNote` pure helper) is re-exported by the bundle and
 * ported directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { EmptyResultError } from '../../../src/runtime/errors.js';
import {
  makeFakeXiaohongshuPage,
  setEvaluateOnceSequence,
} from '../_helpers/xiaohongshu-page.js';

import '../../../marketplace/xiaohongshu/creator-notes-summary.js';
import { summarizeCreatorNote } from '../../../marketplace/xiaohongshu/creator-notes-summary.js';

describe('xiaohongshu/creator-notes-summary (marketplace)', () => {
  const getCommand = () => findAdapter('xiaohongshu', 'creator-notes-summary');

  it('summarizes note list row and detail rows into one compact row', () => {
    const note = {
      id: 'cccccccccccccccccccccccc',
      title: '示例内容复盘',
      date: '2026年03月18日 20:01',
      views: 549,
      likes: 19,
      collects: 10,
      comments: 7,
      url: 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=cccccccccccccccccccccccc',
    };
    const rows = [
      { section: '笔记信息', metric: 'published_at', value: '2026-03-18 20:01', extra: '' },
      { section: '基础数据', metric: '观看数', value: '549', extra: '' },
      { section: '互动数据', metric: '点赞数', value: '19', extra: '' },
      { section: '互动数据', metric: '收藏数', value: '10', extra: '' },
      { section: '互动数据', metric: '评论数', value: '7', extra: '' },
      { section: '互动数据', metric: '分享数', value: '6', extra: '' },
      { section: '基础数据', metric: '平均观看时长', value: '51.5秒', extra: '' },
      { section: '基础数据', metric: '涨粉数', value: '3', extra: '' },
      { section: '观看来源', metric: '首页推荐', value: '89.9%', extra: '' },
      { section: '观看来源', metric: '搜索', value: '0.3%', extra: '' },
      { section: '观众画像', metric: '兴趣/二次元', value: '13%', extra: '' },
      { section: '观众画像', metric: '兴趣/游戏', value: '11%', extra: '' },
    ];
    expect(summarizeCreatorNote(note, rows, 1)).toEqual({
      rank: 1,
      id: 'cccccccccccccccccccccccc',
      title: '示例内容复盘',
      published_at: '2026-03-18 20:01',
      views: '549',
      likes: '19',
      collects: '10',
      comments: '7',
      shares: '6',
      avg_view_time: '51.5秒',
      rise_fans: '3',
      top_source: '首页推荐',
      top_source_pct: '89.9%',
      top_interest: '二次元',
      top_interest_pct: '13%',
      url: 'https://creator.xiaohongshu.com/statistics/note-detail?noteId=cccccccccccccccccccccccc',
    });
  });

  it('waits between note detail fetches after the first note', async () => {
    // Capture map for the notes-LIST phase: one analyze page, total=2, two
    // id+title-bearing notes → the inlined fetchCreatorNotes capture path
    // returns 2 complete notes (no DOM title backfill needed).
    const listCaptureMap = {
      '/api/galaxy/creator/datacenter/note/analyze/list?type=0&page_size=10&page_num=1': {
        ok: true,
        body: JSON.stringify({
          data: {
            total: 2,
            note_infos: [
              {
                id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                title: 'n1',
                post_time: new Date('2026-03-18T20:01:00+08:00').getTime(),
                read_count: 1,
                like_count: 1,
                fav_count: 1,
                comment_count: 1,
              },
              {
                id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
                title: 'n2',
                post_time: new Date('2026-03-19T20:01:00+08:00').getTime(),
                read_count: 2,
                like_count: 2,
                fav_count: 2,
                comment_count: 2,
              },
            ],
          },
        }),
      },
    };
    // Detail DOM payload returned for each per-note detail fetch — enough to
    // make `fetchCreatorNoteDetailRows` yield a core metric so summarize works.
    const detailDom = {
      title: '',
      infoText: '2026-03-18 20:01',
      sections: [
        { title: '基础数据', metrics: [{ label: '观看数', value: '1', extra: '' }] },
      ],
    };

    // Stateful router: the `JSON.stringify(window.__xhsCapture || {})` probe
    // is shared by the list capture path and the per-note detail capture path,
    // so disambiguate by the most recent pushState target the bundle navigated
    // to (data-analysis = list phase, note-detail = detail phase).
    let phase: 'list' | 'detail' = 'list';
    const page = makeFakeXiaohongshuPage();
    page.evaluate = vi.fn(async (script: unknown) => {
      const s = String(script);
      if (s.includes('history.pushState')) {
        if (s.includes('/statistics/note-detail')) phase = 'detail';
        else if (s.includes('/statistics/data-analysis')) phase = 'list';
        return undefined;
      }
      if (s.includes('window.__xhsCapture =')) return undefined;
      if (s.includes('JSON.stringify(window.__xhsCapture')) {
        return phase === 'list' ? JSON.stringify(listCaptureMap) : JSON.stringify({});
      }
      if (s.includes("document.querySelector('.note-title')")) return detailDom;
      if (s.includes('document.body.innerText')) return '';
      return undefined;
    });

    const result = (await getCommand()!.func!(page, { limit: 2 })) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    // Summary loop waits before every note after the first → exactly one wait
    // with a { time } arg (other page.wait calls inside the capture polls take
    // a bare number, so filter to the object-arg form the summary loop uses).
    const summaryWaits = page.wait.mock.calls.filter(
      ([arg]: [unknown]) =>
        arg !== null && typeof arg === 'object' && 'time' in (arg as Record<string, unknown>),
    );
    expect(summaryWaits).toHaveLength(1);
    expect(summaryWaits[0][0]).toEqual(expect.objectContaining({ time: expect.any(Number) }));
  });

  it('throws EmptyResultError when there are no notes to summarize', async () => {
    // Make every inlined fetch path come up empty: capture poll yields {} (no
    // analyze rows), api path yields no note_infos, dom path yields empty body.
    const page = makeFakeXiaohongshuPage();
    setEvaluateOnceSequence(page, [
      undefined, // installXhsFetchCaptureHook
      undefined, // pushState
      JSON.stringify({}), // pollCaptureMap → empty (capture path returns [])
      // fetchCreatorNotesByApi: fetch() → no note_infos
      { data: { note_infos: [] } },
      // fetchCreatorNotesByApi interceptor re-fetch returns true; then DOM fallback:
      // domCards → [] then body → empty text/html → parsedNotes = []
      [],
      { text: '', html: '' },
    ]);

    await expect(getCommand()!.func!(page, { limit: 2 })).rejects.toBeInstanceOf(EmptyResultError);
  });
});
