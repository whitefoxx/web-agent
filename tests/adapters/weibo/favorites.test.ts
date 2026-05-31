/**
 * Port of opencli's clis/weibo/favorites.test.js.
 *
 * The bundled adapter calls `page.evaluate` several times: a Vue-store uid
 * probe (then optionally a config fetch), three `window.scrollBy` scroll
 * scripts, and a final card-extraction script. Opencli's `makePage` feeds a
 * QUEUE of results but lets scroll scripts pass through as `undefined`
 * without consuming the queue — so the queue is `[uid, cards]`. We mirror
 * that with `makeQueuePage`; only the registry lookup and error imports
 * change per the port cheatsheet.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import { makeQueuePage } from '../_helpers/weibo-page.js';

import '../../../marketplace/weibo/favorites.js';

describe('weibo favorites command (marketplace)', () => {
  const getCommand = () => findAdapter('weibo', 'favorites');

  it('registers as a JS adapter and parses visible favorites', async () => {
    const command = getCommand();
    expect(command?.func).toBeTypeOf('function');

    const page = makeQueuePage([
      '123456',
      [
        {
          text: ['作者A', '昨天 12:00', '来自 iPhone', '这是一条收藏微博', '12', '3', '2'].join(
            '\n',
          ),
          url: 'https://weibo.com/123/AbCd1',
        },
      ],
    ]);

    const result = await command!.func!(page, { limit: 10 });

    expect(result).toEqual([
      {
        author: '作者A',
        text: '这是一条收藏微博',
        time: '昨天 12:00',
        source: '来自 iPhone',
        likes: '12',
        comments: '3',
        reposts: '2',
        url: 'https://weibo.com/123/AbCd1',
      },
    ]);
    expect(page.goto).toHaveBeenCalledWith('https://weibo.com');
    expect(page.goto).toHaveBeenCalledWith('https://www.weibo.com/u/page/fav/123456');
  });

  it('throws AuthRequiredError when uid cannot be resolved', async () => {
    const command = getCommand();
    const page = makeQueuePage([null, null]);

    await expect(command!.func!(page, { limit: 10 })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('validates limit before navigation', async () => {
    const command = getCommand();
    const page = makeQueuePage();

    await expect(command!.func!(page, { limit: 0 })).rejects.toBeInstanceOf(ArgumentError);
    await expect(command!.func!(page, { limit: 51 })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('throws EmptyResultError when no favorite cards are visible', async () => {
    const command = getCommand();
    const page = makeQueuePage(['123456', []]);

    await expect(command!.func!(page, { limit: 10 })).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('throws CommandExecutionError when visible cards cannot be parsed', async () => {
    const command = getCommand();
    const page = makeQueuePage(['123456', [{ text: '添加\n昨天', url: '' }]]);

    await expect(command!.func!(page, { limit: 10 })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('deduplicates repeated cards and applies the requested limit', async () => {
    const command = getCommand();
    const rawCard = {
      text: '作者A\n内容A',
      url: 'https://weibo.com/123/AbCd1',
    };
    const page = makeQueuePage([
      '123456',
      [rawCard, rawCard, { text: '作者B\n内容B', url: 'https://weibo.com/123/AbCd2' }],
    ]);

    const result = (await command!.func!(page, { limit: 1 })) as Array<{ author: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('作者A');
  });
});
