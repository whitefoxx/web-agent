/**
 * Tool subsetting — when the adapter registry exposes a lot of tools, narrow the
 * set sent to the model so the prompt doesn't bloat and tool selection stays
 * sharp. v2 (discovery-token audit 2026-07-10):
 *
 *  - Site matching is ALIAS- and namespace-aware ("小红书" matches xiaohongshu,
 *    "知乎" matches my-zhihu) — v1 only substring-matched the English site token,
 *    so Chinese task text never narrowed anything.
 *  - `activeSites` (sites the session showed interest in: named in text earlier,
 *    hit by find_adapters, loaded via load_adapter — see tools/active-sites.ts)
 *    stay expanded across turns.
 *  - NO-MATCH now narrows too (v1 fell back to the full set): hidden site tools
 *    are compressed into a per-site DIGEST — `site: name(args)` one-liners — for
 *    the system prompt. Hidden tools stay REGISTERED, so a direct call using the
 *    digest's name+args still executes; find_adapters re-expands a site's full
 *    schemas for the next turn. The model is informed, never stranded.
 *
 * Pure — see tests/tool-select.test.ts. docs/agent-harness.md §10.12.
 */

import { SITE_ALIASES } from '../tools/site-aliases';
import { baseSite } from '../adapters/namespace';

export interface ToolSelectConfig {
  /** Only subset when there are MORE than this many tools. */
  threshold: number;
}

export const DEFAULT_TOOL_SELECT: ToolSelectConfig = { threshold: 40 };

interface ToolLike {
  function: {
    name: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
  };
}

export interface ToolSelection<T> {
  tools: T[];
  narrowed: boolean;
  dropped: number;
  /** Sites the task text named (callers persist these as session-active so
   * follow-up turns keep them expanded). */
  matchedSites: string[];
  /** Compact per-site catalog of the HIDDEN site tools ("zhihu: search(query,
   * count?), hot()"), for the system prompt. Undefined when nothing was hidden. */
  digest?: string;
}

function siteOf(name: string): string {
  const i = name.indexOf('__');
  return i >= 0 ? name.slice(0, i) : '';
}

/** Does the task text name this site? Checks the raw token, the base token
 * (explored `my-zhihu` → zhihu), and the base's CN aliases. */
function siteNamedIn(text: string, site: string): boolean {
  const base = baseSite(site).toLowerCase();
  if (text.includes(site.toLowerCase()) || text.includes(base)) return true;
  return (SITE_ALIASES[base] ?? []).some((a) => text.includes(a.toLowerCase()));
}

/** One digest line's tool entry: `name(arg1, arg2?)` — enough for the model to
 * call the (still registered) tool directly without its full schema. */
function toolEntry(t: ToolLike): string {
  const name = t.function.name.slice(t.function.name.indexOf('__') + 2);
  const props = Object.keys(t.function.parameters?.properties ?? {});
  const required = new Set(t.function.parameters?.required ?? []);
  const args = props.map((p) => (required.has(p) ? p : `${p}?`)).join(', ');
  return `${name}(${args})`;
}

/** Sites-with-many-tools digest caps: past these, per-site lines collapse to
 * counts — the model falls back to find_adapters for details. */
const DIGEST_MAX_SITES_DETAILED = 15;
const DIGEST_MAX_TOOLS_PER_SITE = 12;

/** Build the compact catalog of hidden site tools, grouped by site. */
export function buildDigest(hidden: ToolLike[]): string {
  const bySite = new Map<string, ToolLike[]>();
  for (const t of hidden) {
    const s = siteOf(t.function.name);
    if (!s) continue;
    const list = bySite.get(s) ?? [];
    list.push(t);
    bySite.set(s, list);
  }
  const sites = [...bySite.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sites.length > DIGEST_MAX_SITES_DETAILED) {
    return sites.map(([s, list]) => `${s}(${list.length})`).join(' · ');
  }
  return sites
    .map(([s, list]) => {
      const entries = list.slice(0, DIGEST_MAX_TOOLS_PER_SITE).map(toolEntry);
      const more = list.length > DIGEST_MAX_TOOLS_PER_SITE ? ` …${list.length} total` : '';
      return `- ${s}: ${entries.join(', ')}${more}`;
    })
    .join('\n');
}

/**
 * Keep generic (site-agnostic) tools always; keep a site's full schemas when the
 * task text names it OR it's session-active. Everything else is hidden but
 * summarized in `digest`. Few tools → return everything unchanged.
 */
export function selectTools<T extends ToolLike>(
  tools: T[],
  userText: string,
  cfg: ToolSelectConfig = DEFAULT_TOOL_SELECT,
  activeSites: ReadonlySet<string> = new Set(),
): ToolSelection<T> {
  if (tools.length <= cfg.threshold) {
    return { tools, narrowed: false, dropped: 0, matchedSites: [] };
  }
  const text = userText.toLowerCase();
  const matchedSites = new Set<string>();
  for (const t of tools) {
    const s = siteOf(t.function.name);
    if (s && s !== 'generic' && siteNamedIn(text, s)) matchedSites.add(s);
  }
  const kept: T[] = [];
  const hidden: T[] = [];
  for (const t of tools) {
    const s = siteOf(t.function.name);
    const keep =
      !s ||
      s === 'generic' ||
      matchedSites.has(s) ||
      activeSites.has(s) ||
      activeSites.has(baseSite(s));
    (keep ? kept : hidden).push(t);
  }
  return {
    tools: kept,
    narrowed: hidden.length > 0,
    dropped: hidden.length,
    matchedSites: [...matchedSites],
    ...(hidden.length ? { digest: buildDigest(hidden) } : {}),
  };
}
