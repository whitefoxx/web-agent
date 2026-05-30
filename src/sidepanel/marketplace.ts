/**
 * Marketplace client — fetch the bundled adapter catalog so the user can browse
 * and one-click install without leaving the SidePanel.
 *
 * The index is a single self-contained JSON file shipped as a web-accessible
 * resource (`marketplace-index.json` — see vite.config.ts → sandboxPagePlugin
 * which copies marketplace/index.json into dist/, and manifest.json which
 * exposes it via web_accessible_resources). The source for every adapter is
 * inlined, so install reuses the same sandbox-eval path as paste-install:
 *   source string → sandbox eval → captured defs → SW persists + registers.
 *
 * No remote fetching today. If/when we add a "remote index URL" setting, it
 * plugs in here behind the same MarketIndex shape (and a chrome.storage read).
 */

export interface MarketAdapter {
  site: string;
  name: string;
  description: string;
  access?: 'read' | 'write';
  domain?: string;
  type: 'pipeline' | 'func' | 'unknown';
  /** Full adapter source — fed straight into the sandbox evaluator. */
  source: string;
}

export interface MarketIndex {
  version: number;
  generatedFrom: string;
  includeAll: boolean;
  count: number;
  adapters: MarketAdapter[];
}

let cached: MarketIndex | null = null;

/**
 * Stable id used both as the storage primary key (site/name) and as the
 * `bundled:<id>` origin URL recorded with the install.
 */
export function entryId(a: { site: string; name: string }): string {
  return `${a.site}/${a.name}`;
}

export async function fetchMarketIndex(): Promise<MarketIndex> {
  if (cached) return cached;
  const url = chrome.runtime.getURL('marketplace-index.json');
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`market index fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as MarketIndex;
  if (!data || !Array.isArray(data.adapters)) {
    throw new Error('market index malformed: missing adapters array');
  }
  cached = data;
  return data;
}

/**
 * Handpicked set surfaced in a "推荐" row at the top of the market browser.
 * Mix of pipeline (装即用,zero-config) and func (需 Phase B + Chrome 138+
 * 允许用户脚本) so users see both categories from the get-go. Order matters:
 * shown left-to-right top-to-bottom; pipelines first for the smoothest first
 * impression.
 */
export const FEATURED_IDS: readonly string[] = [
  // pipeline —装即用
  'hackernews/top',
  'bilibili/hot',
  'binance/price',
  'zhihu/hot',
  // func — 需要 Phase B (Chrome 138+ + 允许用户脚本开关)
  'xiaohongshu/search',
  'twitter/timeline',
  'youtube/search',
  'weread/notes',
];
