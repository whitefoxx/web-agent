/**
 * Port of opencli's clis/bilibili/video.test.js.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError } from '@base/runtime/errors.js';
import { makeFakeBilibiliPage } from '../_helpers/bilibili-page.js';

import '../../../marketplace/bilibili/video.js';

describe('bilibili/video (marketplace)', () => {
  const command = findAdapter('bilibili', 'video');
  let page = makeFakeBilibiliPage();

  beforeEach(() => {
    page = makeFakeBilibiliPage();
  });

  it('returns a field/value table of video metadata on success', async () => {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: {
        bvid: 'BV1xx411c7mD',
        aid: 12345678,
        title: '三层结构笔记法',
        tname: '教程',
        pubdate: 1775053078,
        duration: 434,
        videos: 1,
        pic: 'https://i1.hdslb.com/some.jpg',
        desc: 'Obsidian 教程',
        owner: { mid: 507578555, name: 'IOI科技' },
        stat: { view: 6128, danmaku: 0, reply: 21, like: 162, coin: 48, favorite: 564, share: 26 },
      },
    });

    const rows = (await command!.func!(page, { bvid: 'BV1xx411c7mD' })) as Array<{
      field: string;
      value: string;
    }>;

    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) {
      expect(row).toHaveProperty('field');
      expect(row).toHaveProperty('value');
    }

    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    expect(byField.bvid).toBe('BV1xx411c7mD');
    expect(byField.title).toBe('三层结构笔记法');
    expect(byField.author).toBe('IOI科技 (mid: 507578555)');
    expect(byField.duration).toBe('7m14s (434s)');
    expect(byField.view).toBe('6128');
    expect(byField.like).toBe('162');

    expect(page.goto).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1xx411c7mD/');
    expect(page.apiGet).toHaveBeenCalledWith(page, '/x/web-interface/view', {
      params: { bvid: 'BV1xx411c7mD' },
    });
  });

  it('throws CommandExecutionError when bilibili view API returns non-zero code', async () => {
    page.apiGet.mockResolvedValueOnce({ code: -404, message: '啥都木有', data: null });

    await expect(command!.func!(page, { bvid: 'BV1xx411c7mD' })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CommandExecutionError && /啥都木有|-404/.test((err as Error).message),
    );
  });

  it('extracts BV ID from full bilibili.com URL input', async () => {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { bvid: 'BV1xx411c7mD', stat: {}, owner: {}, desc: '' },
    });

    await command!.func!(page, { bvid: 'https://www.bilibili.com/video/BV1xx411c7mD/' });

    expect(page.goto).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1xx411c7mD/');
    expect(page.apiGet).toHaveBeenCalledWith(page, '/x/web-interface/view', {
      params: { bvid: 'BV1xx411c7mD' },
    });
  });

  it('extracts BV ID from bilibili URL with trailing query string', async () => {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { bvid: 'BV1Je9EBnEha', stat: {}, owner: {}, desc: '' },
    });

    await command!.func!(page, {
      bvid: 'https://www.bilibili.com/video/BV1Je9EBnEha/?spm_id_from=333.1007&vd_source=abc',
    });

    expect(page.apiGet).toHaveBeenCalledWith(page, '/x/web-interface/view', {
      params: { bvid: 'BV1Je9EBnEha' },
    });
  });

  it('extracts BV ID from m.bilibili.com mobile URL', async () => {
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { bvid: 'BV1xx411c7mD', stat: {}, owner: {}, desc: '' },
    });

    await command!.func!(page, { bvid: 'https://m.bilibili.com/video/BV1xx411c7mD' });

    expect(page.apiGet).toHaveBeenCalledWith(page, '/x/web-interface/view', {
      params: { bvid: 'BV1xx411c7mD' },
    });
  });

  it('returns full description without truncation or whitespace collapse', async () => {
    const longDesc = '第一行描述\n\n第二段，有多个空格   和换行\n\n' + 'x'.repeat(500);
    page.apiGet.mockResolvedValueOnce({
      code: 0,
      data: { bvid: 'BV1xx411c7mD', stat: {}, owner: {}, desc: longDesc },
    });

    const rows = (await command!.func!(page, { bvid: 'BV1xx411c7mD' })) as Array<{
      field: string;
      value: string;
    }>;
    const byField = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    expect(byField.description).toBe(longDesc);
    expect(byField.description.length).toBeGreaterThan(200);
  });
});
