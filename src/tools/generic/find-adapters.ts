import { cli, getRegistry } from '@base/runtime/registry.js';
import { fetchMarketIndex } from '@base/core/marketplace';
import { markSiteActive } from '../active-sites';
import { SITE_ALIASES } from '../site-aliases';
import { baseSite } from '../../adapters/namespace';
import { siteFromHost } from '@base/tools/generic/open-url';
import type { AdapterDef } from '@base/tools/manifest';

export { SITE_ALIASES };

/**
 * Search the adapter marketplace (+ everything already registered: installed /
 * session-loaded / explored adapters) for site-specific tools matching a
 * task/site. Powers the `/find-adapters` command and the agent's "there may be
 * a ready-made adapter" flow (a deterministic adapter beats slow generic-tool
 * scraping).
 *
 * Discovery (browseract-comparison ⑬ → v2): marketplace descriptions are uneven
 * and often single-language, and Chinese queries are usually UNSEGMENTED
 * ("微博热搜" is one whitespace token), so naive substring scoring missed badly.
 * v2 fixes this centrally (better than rewriting 290 descriptions):
 *  - a per-site ALIAS map (CN names + distinctive abbreviations),
 *  - CN↔EN TASK-SYNONYM expansion of query terms,
 *  - VOCAB EXTRACTION: any known site/alias/task word CONTAINED in the query
 *    becomes a term, segmenting CJK ("微博热搜" → 微博 + 热搜) and glued forms
 *    ("zhihu热榜"); URLs in the query contribute their site label,
 *  - WEIGHTED scoring: a site hit (3) dominates name (2) dominates desc (1) —
 *    so "微博 搜索" ranks weibo__search above every other site's search.
 *
 * Read-only + a deliberate side effect: sites of REGISTERED hits are marked
 * session-active so tool-select re-expands their schemas next turn (the model
 * just asked about them). See src/tools/active-sites.ts.
 */

/** Bidirectional CN↔EN task-word clusters: matching any variant of a query term
 * counts as a hit, so "搜索" finds an English "Search …" adapter and vice-versa. */
const TASK_SYNONYM_GROUPS: string[][] = [
  ['search', '搜索', '查找', '搜'],
  ['comment', '评论', 'reply', '回复'],
  ['hot', 'trending', '热榜', '热门', '热搜'],
  ['post', 'publish', '发布', '发帖'],
  ['like', '点赞', '赞'],
  ['follow', '关注'],
  ['message', 'messaging', 'dm', '私信', '发消息', '消息'],
  ['download', '下载'],
  // 首页/timeline: "在我的 X 首页…" must rank a timeline/feed adapter above a
  // site-wide search (session s_mregtz8u — the ask was the user's own feed).
  ['feed', 'timeline', 'home', '动态', '推荐', '时间线', '首页'],
  ['profile', '主页', '资料'],
  ['video', '视频'],
  ['note', '笔记'],
  ['answer', '回答'],
  ['collection', 'favorite', '收藏'],
  ['notebook', '笔记本'],
];

const SYNONYM_OF = new Map<string, string[]>();
for (const g of TASK_SYNONYM_GROUPS) for (const w of g) SYNONYM_OF.set(w, g);

/** The row shape both corpora (marketplace index / live registry) reduce to. */
export interface MatchableAdapter {
  site?: string;
  name?: string;
  description?: string;
  domain?: string;
}

/** Match vocabulary: every site token, alias, and task word (≥2 chars — one-char
 * CJK like 搜/赞 over-triggers as a substring). Extended per call with the
 * corpus's actual site tokens so new marketplace sites match without a code
 * change here. */
function buildVocab(siteTokens: Iterable<string>): Set<string> {
  const vocab = new Set<string>();
  const add = (w: string): void => {
    const t = w.toLowerCase().trim();
    if (t.length >= 2) vocab.add(t);
  };
  for (const s of siteTokens) add(s);
  for (const [site, aliases] of Object.entries(SITE_ALIASES)) {
    add(site);
    aliases.forEach(add);
  }
  for (const g of TASK_SYNONYM_GROUPS) g.forEach(add);
  return vocab;
}

/** Split a query into match terms: whitespace tokens + every vocab word CONTAINED
 * in it (segments unspaced CJK: "微博热搜" → [微博热搜, 微博, 热搜]) + the site
 * label of any URL in it ("看看 https://www.zhihu.com/hot" → zhihu). Pure. */
export function extractTerms(query: string, siteTokens: Iterable<string> = []): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const terms = new Set(q.split(/\s+/).filter(Boolean));
  for (const w of buildVocab(siteTokens)) if (q.includes(w)) terms.add(w);
  for (const m of q.matchAll(/https?:\/\/([^\s/]+)/g)) {
    try {
      const site = siteFromHost(m[1]);
      if (site) terms.add(site.toLowerCase());
    } catch {
      /* not a hostname — skip */
    }
  }
  return [...terms];
}

/** The site-bucket match text: raw site token + base (explored `my-zhihu` must
 * match "知乎"/"zhihu" too) + aliases + domain. */
function siteText(a: MatchableAdapter): string {
  const site = (a.site ?? '').toLowerCase();
  const base = baseSite(site);
  return `${site} ${base} ${(SITE_ALIASES[base] ?? []).join(' ')} ${a.domain ?? ''}`.toLowerCase();
}

/** Weighted score of one adapter against extracted terms. Each term counts its
 * strongest bucket — site/alias/domain (3) > command name (2) > description (1)
 * — with CN↔EN synonym variants tried everywhere. Pure. */
export function scoreAdapter(terms: string[], a: MatchableAdapter): number {
  const sText = siteText(a);
  const nameText = (a.name ?? '').toLowerCase();
  const descText = (a.description ?? '').toLowerCase();
  let score = 0;
  for (const t of terms) {
    const variants = SYNONYM_OF.get(t) ?? [t];
    if (variants.some((v) => sText.includes(v))) score += 3;
    else if (variants.some((v) => nameText.includes(v))) score += 2;
    else if (variants.some((v) => descText.includes(v))) score += 1;
  }
  return score;
}

export interface RankedAdapter extends MatchableAdapter {
  score: number;
  /** A term hit this adapter's site/alias/domain — the strong signal the
   * run-start note builder requires (task-word-only matches are too noisy for
   * unsolicited injection). */
  siteHit: boolean;
}

/** Rank a corpus against a free-text query. Pure (corpus passed in). */
export function rankAdapters(query: string, corpus: MatchableAdapter[]): RankedAdapter[] {
  const terms = extractTerms(
    query,
    corpus.map((a) => baseSite(a.site ?? '')),
  );
  if (terms.length === 0) return [];
  return corpus
    .map((a) => {
      const sText = siteText(a);
      const siteHit = terms.some((t) => (SYNONYM_OF.get(t) ?? [t]).some((v) => sText.includes(v)));
      return { ...a, score: scoreAdapter(terms, a), siteHit };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
}

/** Marketplace index + registered adapters not in it (explored / custom), so
 * discovery covers the user's own tools too. Index fetch failures degrade to
 * registry-only instead of erroring the search. */
export async function searchableCorpus(): Promise<
  (MatchableAdapter & { access?: string; type?: string })[]
> {
  let market: (MatchableAdapter & { access?: string; type?: string })[] = [];
  try {
    market = (await fetchMarketIndex()).adapters;
  } catch {
    /* offline — registry-only */
  }
  const seen = new Set(market.map((a) => `${a.site}__${a.name}`));
  const extras = (getRegistry() as AdapterDef[])
    .filter((d) => d.site !== 'generic' && !seen.has(`${d.site}__${d.name}`))
    .map((d) => ({
      site: d.site,
      name: d.name,
      description: d.description ?? '',
      access: d.access ?? 'read',
      domain: d.domain ?? '',
      type: 'loaded',
    }));
  return [...market, ...extras];
}

/** Is `site__name` currently callable (installed / session-loaded / explored)? */
function isRegistered(site: string, name: string): boolean {
  return (getRegistry() as AdapterDef[]).some((d) => d.site === site && d.name === name);
}

cli({
  site: 'generic',
  name: 'find_adapters',
  access: 'read',
  local: true,
  description:
    'Search for an adapter (a site-specific tool) suited to a task/site, covering the marketplace and installed/loaded adapters. Returns the best-matching list (site/name/description/whether it is a write op/type/status). **Search before starting any data task on a mainstream site**; also use it when generic tools alone are slow, or when the user asks whether a ready-made tool/adapter exists. Supports Chinese↔English site aliases (微博/领英/推特…), Chinese↔English task words (搜索↔search, 评论↔comment…), and unspaced Chinese (“微博热搜”). **`status` field**: a loaded one can be called directly by site__name; an unloaded one must first be brought into this session with `load_adapter` (site+name) before calling (an adapter needs no install and is not persisted; next task, just search and load again). **`type` field**: `pipeline` needs no toggle and is always available; `func` requires Chrome’s “allow user scripts” toggle (load fails if it is off) — the toggle state is in the system’s “runtime environment note”; if it is off, prefer a pipeline-type adapter or fall back to generic tools.',
  args: [
    {
      name: 'query',
      type: 'string',
      required: true,
      help: 'Task or site keywords, e.g. “知乎 热榜” / “xiaohongshu” / “微博热搜” / “领英 私信”',
    },
  ],
  columns: ['site', 'name', 'description', 'access', 'type', 'status'],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const q = String(kwargs.query ?? '').trim();
    if (!q) return [];
    const corpus = await searchableCorpus();
    const ranked = rankAdapters(q, corpus).slice(0, 12);
    return ranked.map((a) => {
      const site = a.site ?? '';
      const name = a.name ?? '';
      const registered = isRegistered(site, name);
      // The model just asked about this site — make sure its (already
      // registered) tools are expanded in the next turn's catalog.
      if (registered) markSiteActive(site);
      const row = a as MatchableAdapter & { access?: string; type?: string };
      return {
        site,
        name,
        description: a.description ?? '',
        access: row.access ?? 'read',
        // func needs the "allow user scripts" toggle; pipeline runs regardless. The model
        // uses this + the env note to pick a strategy (adapter-hot-plug §10.39).
        type: row.type ?? 'unknown',
        status: registered ? 'loaded: call directly' : 'not loaded: load_adapter first',
      };
    });
  },
});
