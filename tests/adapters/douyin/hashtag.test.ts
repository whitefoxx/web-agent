/**
 * Port of opencli's clis/douyin/hashtag.test.js.
 *
 * opencli mocks `browserFetch`; inlined here, so we drive page.browserFetch via
 * makeFakeDouyinPage(). The URL is the 3rd positional arg (mock.calls[i][2]).
 *
 * Note: tests that resolve a malformed payload (null / wrong-shape) trip
 * EITHER the inlined browserFetch validation OR the adapter's own
 * requireListField — both throw CommandExecutionError, matching opencli.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { ArgumentError, CommandExecutionError } from '@base/runtime/errors.js';
import { makeFakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/hashtag.js';

describe('douyin/hashtag (marketplace)', () => {
  const command = findAdapter('douyin', 'hashtag');
  let page = makeFakeDouyinPage();

  beforeEach(() => {
    page = makeFakeDouyinPage();
  });

  it('registers the hashtag command', () => {
    expect(command).toBeDefined();
    expect(command?.args.some((a: { name: string }) => a.name === 'action')).toBe(true);
  });

  it('has all expected args', () => {
    const argNames = command?.args.map((a: { name: string }) => a.name) ?? [];
    expect(argNames).toContain('action');
    expect(argNames).toContain('keyword');
    expect(argNames).toContain('cover');
    expect(argNames).toContain('limit');
  });

  it('uses COOKIE strategy', () => {
    expect(command?.strategy).toBe('cookie');
  });

  it('registers action-specific validation so missing args fail before browser pre-navigation', () => {
    expect(command?.validateArgs).toBeTypeOf('function');
    expect(() =>
      command!.validateArgs!({ action: 'search', keyword: '', cover: '', limit: 10 }),
    ).toThrow(ArgumentError);
    expect(() =>
      command!.validateArgs!({ action: 'suggest', keyword: '速效救心丸', cover: '', limit: 10 }),
    ).toThrow(ArgumentError);
    expect(() =>
      command!.validateArgs!({ action: 'hot', keyword: '', cover: '', limit: 10 }),
    ).not.toThrow();
    expect(page.browserFetch).not.toHaveBeenCalled();
  });

  it('search throws ArgumentError when --keyword is missing or blank (#1689)', async () => {
    await expect(
      command!.func!(page, { action: 'search', keyword: '', cover: '', limit: 10 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    await expect(
      command!.func!(page, { action: 'search', keyword: '   ', cover: '', limit: 10 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    expect(page.browserFetch).not.toHaveBeenCalled();
  });

  it('suggest throws ArgumentError when --cover is missing (#1689 root cause)', async () => {
    await expect(
      command!.func!(page, { action: 'suggest', keyword: '速效救心丸', cover: '', limit: 10 }),
    ).rejects.toMatchObject({ code: 'ARGUMENT', message: expect.stringContaining('--cover') });
    await expect(
      command!.func!(page, { action: 'suggest', keyword: '', cover: '   ', limit: 10 }),
    ).rejects.toBeInstanceOf(ArgumentError);
    expect(page.browserFetch).not.toHaveBeenCalled();
  });

  it('hot accepts empty --keyword (it is optional for hot)', async () => {
    page.browserFetch.mockResolvedValueOnce({
      hotspot_list: [{ sentence: '热点1', hot_value: 100, sentence_id: 'h1' }],
    });
    const rows = (await command!.func!(page, {
      action: 'hot',
      keyword: '',
      cover: '',
      limit: 5,
    })) as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ name: '热点1', id: 'h1', view_count: 100 });
    const url = page.browserFetch.mock.calls[0][2];
    expect(url).not.toContain('keyword=');
  });

  it('search threads --keyword + count into the challenge/search URL', async () => {
    page.browserFetch.mockResolvedValueOnce({
      challenge_list: [{ challenge_info: { cha_name: '美食', cid: '123', view_count: 5000 } }],
    });
    const rows = await command!.func!(page, {
      action: 'search',
      keyword: '美食',
      cover: '',
      limit: 10,
    });
    expect(rows).toEqual([{ name: '美食', id: '123', view_count: 5000 }]);
    const url = page.browserFetch.mock.calls[0][2];
    expect(url).toContain('challenge/search');
    expect(url).toContain('keyword=' + encodeURIComponent('美食'));
    expect(url).toContain('count=10');
  });

  it('suggest threads --cover into the hashtag/rec URL on success', async () => {
    page.browserFetch.mockResolvedValueOnce({
      hashtag_list: [{ name: '推荐话题', id: 'h99', view_count: 1234 }],
    });
    const rows = await command!.func!(page, {
      action: 'suggest',
      keyword: '',
      cover: 'tos-cn-i-cover/abc',
      limit: 10,
    });
    expect(rows).toEqual([{ name: '推荐话题', id: 'h99', view_count: 1234 }]);
    const url = page.browserFetch.mock.calls[0][2];
    expect(url).toContain('hashtag/rec');
    expect(url).toContain('cover_uri=' + encodeURIComponent('tos-cn-i-cover/abc'));
  });

  it('search throws CommandExecutionError when API returns a non-object payload', async () => {
    page.browserFetch.mockResolvedValueOnce(null);
    await expect(
      command!.func!(page, { action: 'search', keyword: '美食', cover: '', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('search throws CommandExecutionError when challenge_list has wrong shape', async () => {
    page.browserFetch.mockResolvedValueOnce({ challenge_list: 'not-an-array' });
    await expect(
      command!.func!(page, { action: 'search', keyword: '美食', cover: '', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('search throws CommandExecutionError when challenges return but none parse', async () => {
    page.browserFetch.mockResolvedValueOnce({
      challenge_list: [{ challenge_info: null }, { other_field: 1 }],
    });
    await expect(
      command!.func!(page, { action: 'search', keyword: '美食', cover: '', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('suggest throws CommandExecutionError when hashtag_list has wrong shape', async () => {
    page.browserFetch.mockResolvedValueOnce({ hashtag_list: 'oops' });
    await expect(
      command!.func!(page, { action: 'suggest', keyword: '', cover: 'tos-cn-i-cover/x', limit: 10 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('hot throws CommandExecutionError when hotspot_list has wrong shape', async () => {
    page.browserFetch.mockResolvedValueOnce({ hotspot_list: { malformed: true } });
    await expect(
      command!.func!(page, { action: 'hot', keyword: '', cover: '', limit: 5 }),
    ).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('parses the current hotspot recommendation shape', async () => {
    expect(command?.func).toBeDefined();
    page.browserFetch.mockResolvedValueOnce({
      all_sentences: [
        {
          word: '在公园花海里大晒一场',
          hot_value: 12141172,
          sentence_id: '2448416',
        },
      ],
    });
    const rows = await command!.func!(page, { action: 'hot', keyword: '', limit: 5 });
    expect(rows).toEqual([
      {
        name: '在公园花海里大晒一场',
        id: '2448416',
        view_count: 12141172,
      },
    ]);
  });
});
