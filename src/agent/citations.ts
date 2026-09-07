/**
 * Citations / sources for agent replies.
 *
 * Two jobs, both engine-side:
 *  1. `collectSourcesFromTool` — during a run, accumulate the external pages the
 *     agent ACTUALLY fetched/navigated to (fetch_url final URL, open_url). Search
 *     hits (web_search) are candidates, not sources, so they're intentionally not
 *     collected here — that would dump ~10 noisy URLs per search.
 *  2. `appendSourcesFooter` — a GROUNDED FALLBACK: if the model's final answer
 *     cites nothing (no "Sources" heading, none of the collected URLs inline),
 *     append a "Sources" list built from the collected pages so an answer is never
 *     left source-less. When the model DID cite (the prompt asks it to), we leave
 *     its own inline [n] + sources list untouched.
 *
 * The inline [n] → clickable superscript rendering lives UI-side in Markdown.tsx;
 * the footer is emitted as plain markdown text so it needs no schema change.
 */

export interface SourceRef {
  url: string;
  title?: string;
}

/** A "来源 / 参考 / 引用 / Sources / References" heading line (Chinese variants
 * kept as they match model-produced output). */
const SOURCE_HEADING =
  /(^|\n)[ \t]*(来源|参考(资料)?|引用|Sources?|References?)[ \t]*[:：]?[ \t]*(\n|$)/i;

const NON_CITABLE = /^(about:|chrome:|chrome-extension:|edge:|data:|blob:|javascript:|file:)/i;

function isCitableUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && !NON_CITABLE.test(u);
}

/** Normalize for dedup: drop the hash + a trailing slash so the same page logged
 * twice (e.g. via open_url then fetch_url) collapses to one source. */
function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

function pushSource(sink: SourceRef[], url: string, title?: string): void {
  const key = normUrl(url);
  const existing = sink.find((s) => normUrl(s.url) === key);
  if (existing) {
    if (!existing.title && title) existing.title = title; // upgrade a bare URL once a title shows up
    return;
  }
  sink.push(title ? { url, title } : { url });
}

/** Best-effort <title> from an HTML body (fetch_url returns the raw body). */
function titleFromHtml(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return t || undefined;
}

/** hostname + short path, for a readable label when no page title is known. */
function prettyUrl(u: string): string {
  try {
    const url = new URL(u);
    const path = (url.pathname + url.search).replace(/\/$/, '');
    const s = url.hostname.replace(/^www\./, '') + path;
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return u;
  }
}

/** Sanitize a source label for use as markdown link text (no brackets/newlines). */
function label(s: SourceRef): string {
  const raw = (s.title || prettyUrl(s.url))
    .replace(/[[\]\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return raw || s.url;
}

/**
 * Pull citable external URLs out of one tool's structured result and fold them
 * into `sink` (deduped). Only counts pages the agent genuinely retrieved.
 */
export function collectSourcesFromTool(tool: string, result: unknown, sink: SourceRef[]): void {
  if (!result || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  if (tool === 'fetch_url') {
    if (r.ok !== false && isCitableUrl(r.url)) {
      const title = typeof r.body === 'string' ? titleFromHtml(r.body) : undefined;
      pushSource(sink, r.url, title);
    }
  } else if (tool === 'open_url') {
    if (isCitableUrl(r.url)) pushSource(sink, r.url);
  }
}

/**
 * Grounded fallback footer. Returns `text` unchanged when the model already gave
 * sources (a "Sources" heading, or any collected URL already present inline) or
 * when nothing citable was collected; otherwise appends a "Sources" markdown list.
 */
export function appendSourcesFooter(text: string, sources: SourceRef[]): string {
  const seen = new Set<string>();
  const uniq: SourceRef[] = [];
  for (const s of sources) {
    const k = normUrl(s.url);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(s);
    if (uniq.length >= 12) break; // a source-less answer shouldn't turn into a link dump
  }
  if (!uniq.length) return text;
  if (SOURCE_HEADING.test(text)) return text; // model already listed sources
  if (uniq.some((s) => text.includes(s.url))) return text; // model cited a URL inline
  const lines = uniq.map((s, i) => `${i + 1}. [${label(s)}](${s.url})`);
  return `${text.trimEnd()}\n\nSources:\n${lines.join('\n')}`;
}
