/**
 * Tool subsetting pure helper (src/agent/tool-select.ts). docs §10.12 + v2
 * (discovery-token audit 2026-07-10): alias/namespace-aware site matching,
 * session-active sites, and the no-match case narrowing to generic + a per-site
 * digest instead of falling back to the full catalog.
 */
import { describe, expect, it } from 'vitest';
import { selectTools, buildDigest } from '../src/agent/tool-select';

const T = (name: string, props: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function' as const,
  function: {
    name,
    description: '',
    parameters: { type: 'object', properties: props, required },
  },
});
const many = (n: number, site: string) => Array.from({ length: n }, (_, i) => T(`${site}__c${i}`));

describe('selectTools', () => {
  it('returns all unchanged when under the threshold', () => {
    const tools = [T('generic__open_url'), T('bilibili__hot')];
    const sel = selectTools(tools, '看 bilibili', { threshold: 40 });
    expect(sel.narrowed).toBe(false);
    expect(sel.tools).toHaveLength(2);
  });

  it('narrows to generic + the named site when over threshold', () => {
    const tools = [...many(10, 'generic'), ...many(20, 'bilibili'), ...many(20, 'twitter')];
    const sel = selectTools(tools, '帮我看 bilibili 的视频', { threshold: 40 });
    expect(sel.narrowed).toBe(true);
    expect(sel.dropped).toBe(20); // twitter dropped
    expect(sel.tools.some((t) => t.function.name.startsWith('twitter__'))).toBe(false);
    expect(sel.tools.filter((t) => t.function.name.startsWith('bilibili__'))).toHaveLength(20);
    expect(sel.tools.filter((t) => t.function.name.startsWith('generic__'))).toHaveLength(10);
    expect(sel.matchedSites).toEqual(['bilibili']);
    // The dropped site is still discoverable via the digest.
    expect(sel.digest).toContain('twitter');
  });

  it('a CHINESE site alias matches (v1 regression: 小红书 never matched xiaohongshu)', () => {
    const tools = [...many(10, 'generic'), ...many(20, 'xiaohongshu'), ...many(20, 'twitter')];
    const sel = selectTools(tools, '帮我搜下小红书的露营笔记', { threshold: 40 });
    expect(sel.matchedSites).toEqual(['xiaohongshu']);
    expect(sel.tools.filter((t) => t.function.name.startsWith('xiaohongshu__'))).toHaveLength(20);
    expect(sel.tools.some((t) => t.function.name.startsWith('twitter__'))).toBe(false);
  });

  it('the explored namespace (my-zhihu) matches its base site name + alias', () => {
    const tools = [...many(10, 'generic'), ...many(20, 'my-zhihu'), ...many(20, 'twitter')];
    for (const text of ['查一下知乎热榜', 'check zhihu hot list']) {
      const sel = selectTools(tools, text, { threshold: 40 });
      expect(sel.matchedSites).toEqual(['my-zhihu']);
      expect(sel.tools.filter((t) => t.function.name.startsWith('my-zhihu__'))).toHaveLength(20);
    }
  });

  it('no named site → narrows to generic + digest (v2: no more full-set fallback)', () => {
    const tools = [...many(10, 'generic'), ...many(40, 'bilibili')];
    const sel = selectTools(tools, '随便看看', { threshold: 40 });
    expect(sel.narrowed).toBe(true);
    expect(sel.tools).toHaveLength(10); // generic only
    expect(sel.dropped).toBe(40);
    expect(sel.matchedSites).toEqual([]);
    expect(sel.digest).toContain('bilibili');
  });

  it('session-active sites stay expanded without being named', () => {
    const tools = [...many(10, 'generic'), ...many(20, 'bilibili'), ...many(20, 'twitter')];
    const sel = selectTools(tools, '继续', { threshold: 40 }, new Set(['bilibili']));
    expect(sel.tools.filter((t) => t.function.name.startsWith('bilibili__'))).toHaveLength(20);
    expect(sel.tools.some((t) => t.function.name.startsWith('twitter__'))).toBe(false);
    expect(sel.digest).toContain('twitter');
  });

  it('an active BASE site keeps its explored-namespace tools too', () => {
    const tools = [...many(10, 'generic'), ...many(35, 'my-zhihu')];
    const sel = selectTools(tools, '继续', { threshold: 40 }, new Set(['zhihu']));
    expect(sel.tools.filter((t) => t.function.name.startsWith('my-zhihu__'))).toHaveLength(35);
  });

  it('keeps multiple named sites', () => {
    const tools = [...many(5, 'generic'), ...many(30, 'bilibili'), ...many(30, 'weibo')];
    const sel = selectTools(tools, '对比 bilibili 和 weibo', { threshold: 40 });
    expect(sel.tools.some((t) => t.function.name.startsWith('bilibili__'))).toBe(true);
    expect(sel.tools.some((t) => t.function.name.startsWith('weibo__'))).toBe(true);
    expect(sel.dropped).toBe(0);
  });
});

describe('buildDigest', () => {
  it('renders name(args) per site, ?-marking optional args', () => {
    const digest = buildDigest([
      T('zhihu__search', { query: {}, count: {} }, ['query']),
      T('zhihu__hot'),
      T('weibo__feed', { count: {} }),
    ]);
    expect(digest).toContain('- zhihu: search(query, count?), hot()');
    expect(digest).toContain('- weibo: feed(count?)');
  });

  it('collapses to per-site counts when there are many sites', () => {
    const hidden = Array.from({ length: 20 }, (_, i) => T(`site${i}__a`, { q: {} }));
    const digest = buildDigest(hidden);
    expect(digest).toContain('site0(1)');
    expect(digest).not.toContain('a(q?)');
  });
});
