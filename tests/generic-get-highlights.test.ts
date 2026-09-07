/**
 * get_highlights — agent-side read of 划词助手 persistent highlights
 * ("把我的所有高亮分类总结"). Chrome storage stubbed; verifies grouping
 * (newest page first), query filter, and the limit cap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/tools/generic/get-highlights';
import { getRegistry } from '@base/runtime/registry.js';
import { FEATURES } from '../src/config/features';

type Def = {
  site: string;
  name: string;
  func: (p: unknown, k: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const tool = (getRegistry() as Def[]).find(
  (d) => d.site === 'generic' && d.name === 'get_highlights',
)!;

const STORE: Record<string, unknown> = {
  'selHl:https://a.com/post': [
    { id: '1', exact: 'LLM 推理成本下降', prefix: '', suffix: '', ts: 1000, title: 'A 文章' },
    { id: '2', exact: 'context caching 机制', prefix: '', suffix: '', ts: 3000, title: 'A 文章' },
  ],
  'selHl:https://b.com/doc': [
    { id: '3', exact: '浏览器扩展的 MV3 限制', prefix: '', suffix: '', ts: 2000, title: 'B 文档' },
  ],
  somethingElse: { not: 'a highlight' },
};

beforeEach(() => {
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        getKeys: async () => Object.keys(STORE),
        get: async (keys: string | string[]) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.map((k) => [k, STORE[k]]));
        },
      },
    },
  });
});

// Gated behind the 划词助手 feature: on the product build the tool isn't
// registered (FEATURES.selectionToolbar=false), so skip — restore the feature
// and this suite runs again.
describe.skipIf(!FEATURES.selectionToolbar)('get_highlights', () => {
  it('groups by page, newest page first, entries newest first, with title', async () => {
    const r = await tool.func(null, {});
    expect(r.pages).toBe(2);
    expect(r.total).toBe(3);
    const results = r.results as { url: string; title: string; highlights: { text: string }[] }[];
    expect(results[0].url).toBe('https://a.com/post'); // max ts 3000 first
    expect(results[0].title).toBe('A 文章');
    expect(results[0].highlights.map((h) => h.text)).toEqual([
      'context caching 机制',
      'LLM 推理成本下降',
    ]);
    expect(results[1].url).toBe('https://b.com/doc');
  });

  it('query filters across url/title/highlight text', async () => {
    const byText = await tool.func(null, { query: 'caching' });
    expect(byText.total).toBe(1);
    const byTitle = await tool.func(null, { query: 'b 文档' });
    expect(byTitle.total).toBe(1);
    const byUrl = await tool.func(null, { query: 'a.com' });
    expect(byUrl.total).toBe(2);
    const miss = await tool.func(null, { query: 'nomatch-xyz' });
    expect(miss.total).toBe(0);
    expect(miss.results).toEqual([]);
  });

  it('limit caps the total with a truncated flag', async () => {
    const r = await tool.func(null, { limit: 2 });
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(true);
  });
});
