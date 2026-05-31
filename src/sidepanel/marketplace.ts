/**
 * Marketplace client — fetch the bundled adapter catalog so the user can browse
 * and one-click install without leaving the SidePanel.
 *
 * Two-stage fetch (since the schema-v2 rewrite — see docs/adapter-hot-plug.md):
 *
 *   1. `fetchMarketIndex()` — pulls `marketplace/index.json` (metadata only,
 *      no embedded source, ~100KB for ~345 adapters). Cached per SidePanel
 *      session; that catalog is what populates the browse grid.
 *
 *   2. `fetchAdapterSource(adapter)` — only called when the user actually
 *      clicks Install. Fetches the per-adapter `.js` file at
 *      `<baseUrl>/<adapter.source>` and verifies sha256 before returning.
 *      Hash mismatch → refuse install (defends both built-in tampering and
 *      the future remote case where review-then-swap is a real attack).
 *
 * Where the source lives:
 *   - Today: bundled with the extension at `marketplace/<site>/<name>.js`,
 *     fetched via `chrome.runtime.getURL('marketplace/')` (a local resource;
 *     near-zero latency).
 *   - Future (remote marketplace, official + community tiers): same schema
 *     and per-file convention served over HTTPS. The only thing that needs to
 *     change here is the base URL — `adapter.source` stays a relative path.
 */

/** Schema-v2 entry shape (matches scripts/build-marketplace-index.mjs output). */
export interface MarketAdapter {
  site: string;
  name: string;
  description: string;
  access?: 'read' | 'write';
  domain?: string;
  type: 'pipeline' | 'func' | 'unknown';
  /** Trust tier. Today every entry from the built-in tree is 'official';
   * 'community' lands when the remote marketplace + review pipeline ship. */
  tier: 'official' | 'community';
  /** Free-text. For opencli-sourced built-ins this is 'opencli'; community
   * adapters surface the submitting GitHub handle here. */
  author: string;
  /** Per-adapter semver. Bumped manually when the adapter's behaviour
   * changes; for upgrade detection prefer comparing sha256. */
  version: string;
  /** Relative path under the marketplace base URL — e.g. "zhihu/answer-detail.js".
   * Resolved via `new URL(adapter.source, baseUrl)` at fetch time. */
  source: string;
  /** SHA-256 (hex) of the EXACT source bytes the index promised. Verified by
   * fetchAdapterSource before handing off to install. */
  sha256: string;
}

export interface MarketIndex {
  /** Schema version. v1 inlined source per adapter; v2 (current) uses
   * per-file sources + sha256 + tier/author/version. Clients should refuse
   * to load unknown versions (rather than parsing and silently dropping
   * fields). */
  version: 2;
  bundledAt: string;
  generatedFrom: string;
  includeAll: boolean;
  count: number;
  adapters: MarketAdapter[];
}

// No module-level cache: a stale `cachedIndex` after a marketplace rebuild
// was the root cause of `EmptyResultError2 is not defined` resurfacing after
// uninstall+reinstall — the install path used the cached entry's OLD sha256
// against Chrome's HTTP-cached OLD source, both matching → old source went
// back into IDB. See docs/adapter-hot-plug.md §10.15.
// The Marketplace tab already caches the result in React state per mount;
// the index is local (~85KB, instant) so refetching costs nothing.
//
// fetch() below also uses `cache: 'no-store'` to bypass Chrome's
// chrome-extension:// HTTP cache, which is the only other place stale bytes
// could come from.

/** Stable id used both as the IDB primary key (site/name) and as the
 * `bundled:<id>` origin URL recorded with the install. */
export function entryId(a: { site: string; name: string }): string {
  return `${a.site}/${a.name}`;
}

/** Today's base URL — extension-internal. When the remote marketplace ships,
 * resolve from `chrome.storage.local` (`remoteMarketUrl` setting) and fall
 * back to this. */
function defaultBaseUrl(): string {
  // Trailing slash is required so `new URL('zhihu/x.js', base)` resolves
  // relative to the marketplace/ dir, not its parent.
  return chrome.runtime.getURL('marketplace/');
}

export async function fetchMarketIndex(baseUrl: string = defaultBaseUrl()): Promise<MarketIndex> {
  const url = new URL('index.json', baseUrl).toString();
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`market index fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as MarketIndex;
  if (!data || !Array.isArray(data.adapters)) {
    throw new Error('market index malformed: missing adapters array');
  }
  if (data.version !== 2) {
    // Refuse v1: that schema embedded source verbatim and lacked sha256, so a
    // half-migrated cache would silently fail. Force a build regen.
    throw new Error(
      `market index schema mismatch: expected v2, got v${(data as { version?: unknown }).version}. ` +
        `Rebuild: node scripts/build-marketplace-index.mjs --popular`,
    );
  }
  return data;
}

/** SHA-256 hex of a UTF-8 string. Pure (no I/O) so it's straight-line testable. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch the actual adapter source for an entry and verify it matches the
 * index's promised sha256. Throws on fetch failure OR mismatch — install
 * code should propagate the error (don't fall back to the bytes; a hash
 * mismatch is either a CDN race, a stale cache, or active tampering, none
 * of which the user wants silently installed).
 */
export async function fetchAdapterSource(
  adapter: MarketAdapter,
  baseUrl: string = defaultBaseUrl(),
): Promise<string> {
  const url = new URL(adapter.source, baseUrl).toString();
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`adapter source fetch failed: ${resp.status} ${resp.statusText} (${url})`);
  }
  const text = await resp.text();
  const got = await sha256Hex(text);
  if (got !== adapter.sha256) {
    throw new Error(
      `adapter source sha256 mismatch for ${entryId(adapter)}: index says ${adapter.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`,
    );
  }
  return text;
}

/**
 * Handpicked set surfaced in a "推荐" row at the top of the market browser.
 * Mix of pipeline (装即用, zero-config) and func (需 Phase B + Chrome 138+
 * 允许用户脚本) so users see both categories from the get-go. Order matters:
 * shown left-to-right top-to-bottom; pipelines first for the smoothest first
 * impression.
 */
export const FEATURED_IDS: readonly string[] = [
  // pipeline — 装即用
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
