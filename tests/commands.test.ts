/**
 * commands — the `/` palette catalog merge. `mergeToolCatalog` unions the live
 * registry (generic + loaded/synthesized adapters, with arg schemas) with the
 * full marketplace catalog (metadata only), so `/` can reference ANY adapter
 * even before it's loaded. Registry entries win on dedupe.
 */
import { describe, it, expect } from 'vitest';
import { mergeToolCatalog } from '../src/sidepanel/commands';
import type { AdapterCommand } from '../src/messages';
import type { MarketAdapter } from '@base/core/marketplace';

const reg = (tool: string, extra: Partial<AdapterCommand> = {}): AdapterCommand => {
  const [site, name] = tool.split('__');
  return { tool, site, name, kind: 'unknown', ...extra };
};
const mkt = (site: string, name: string, extra: Partial<MarketAdapter> = {}): MarketAdapter => ({
  site,
  name,
  description: `${site}/${name}`,
  type: 'pipeline',
  tier: 'official',
  author: 'x',
  version: '1',
  source: `${site}/${name}.js`,
  sha256: 'deadbeef',
  ...extra,
});

describe('mergeToolCatalog', () => {
  it('appends market adapters not already in the registry, registry first', () => {
    const registry = [reg('generic__open_url'), reg('zhihu__hot')];
    const market = [mkt('zhihu', 'hot'), mkt('weibo', 'search'), mkt('bilibili', 'hot')];
    const merged = mergeToolCatalog(registry, market);
    const tools = merged.map((c) => c.tool);
    // registry entries kept, in order, first
    expect(tools.slice(0, 2)).toEqual(['generic__open_url', 'zhihu__hot']);
    // zhihu__hot NOT duplicated (registry won); the other two appended
    expect(tools.filter((t) => t === 'zhihu__hot')).toHaveLength(1);
    expect(tools).toContain('weibo__search');
    expect(tools).toContain('bilibili__hot');
    expect(tools).toHaveLength(4);
  });

  it('maps a market adapter to an AdapterCommand (tool/site/name/kind from type)', () => {
    const merged = mergeToolCatalog([], [mkt('twitter', 'timeline', { type: 'func' })]);
    expect(merged[0]).toMatchObject({
      tool: 'twitter__timeline',
      site: 'twitter',
      name: 'timeline',
      kind: 'func',
    });
  });

  it('dedupes duplicate market entries too (first wins)', () => {
    const merged = mergeToolCatalog([], [mkt('a', 'b'), mkt('a', 'b', { description: 'dup' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toBe('a/b');
  });

  it('preserves registry arg schemas (not overwritten by metadata-only market entry)', () => {
    const registry = [reg('zhihu__hot', { args: [{ name: 'q', type: 'string' }] })];
    const merged = mergeToolCatalog(registry, [mkt('zhihu', 'hot')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].args).toEqual([{ name: 'q', type: 'string' }]);
  });
});
