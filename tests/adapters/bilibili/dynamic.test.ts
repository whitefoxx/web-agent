/**
 * Port of opencli's clis/bilibili/dynamic.test.js for the marketplace-bundled
 * artifact. opencli mocked `./utils.js`'s apiGet — we mock at the page.evaluate
 * level via the shared fake page (see tests/adapters/_helpers/bilibili-page.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeBilibiliPage } from '../_helpers/bilibili-page.js';

import '../../../marketplace/bilibili/dynamic.js';

describe('bilibili/dynamic (marketplace)', () => {
  const command = findAdapter('bilibili', 'dynamic');
  let page = makeFakeBilibiliPage();

  beforeEach(() => {
    page = makeFakeBilibiliPage();
  });

  it('maps desc text rows from the dynamic feed payload', async () => {
    page.apiGet.mockResolvedValueOnce({
      data: {
        items: [
          {
            id_str: '123',
            modules: {
              module_author: { name: 'Alice' },
              module_dynamic: { desc: { text: 'hello world' } },
              module_stat: { like: { count: 9 } },
            },
          },
        ],
      },
    });

    const result = await command!.func!(page, { limit: 5 });

    expect(page.apiGet).toHaveBeenCalledWith(page, '/x/polymer/web-dynamic/v1/feed/all', {
      params: {},
    });
    expect(result).toEqual([
      {
        id: '123',
        author: 'Alice',
        text: 'hello world',
        likes: 9,
        url: 'https://t.bilibili.com/123',
      },
    ]);
  });

  it('falls back to archive title when desc text is absent', async () => {
    page.apiGet.mockResolvedValueOnce({
      data: {
        items: [
          {
            id_str: '456',
            modules: {
              module_author: { name: 'Bob' },
              module_dynamic: { major: { archive: { title: 'Video title' } } },
              module_stat: { like: { count: 3 } },
            },
          },
        ],
      },
    });

    const result = await command!.func!(page, { limit: 5 });
    expect(result).toEqual([
      {
        id: '456',
        author: 'Bob',
        text: 'Video title',
        likes: 3,
        url: 'https://t.bilibili.com/456',
      },
    ]);
  });
});
