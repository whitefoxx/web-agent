/**
 * Synthesis (P3): turn an explore trace into a deterministic opencli adapter.
 *
 * One LLM call. The system prompt internalizes opencli's adapter-author
 * knowledge (strategy selection, cli() shape, signed-token handling, prefer a
 * single fetch over DOM scraping). Input is a compact digest of the trace
 * (deduped endpoints + body samples + action sequence + a DOM snapshot). Output
 * is an opencli `cli({...})` source string the existing sandbox-eval install
 * path can consume verbatim. See docs/llm-explore.md.
 */

import { chatCompletion } from '../agent/api-engine';
import { anySignal } from '../agent/resilience';
import { log, warn } from '@base/runtime/log';
import type { Trace, TraceActionEvent, TraceNetworkEvent, TraceStateEvent } from './types';
import type { CapturedSubmission } from '../runtime/submission-capture';

/** Hard ceiling for the single synth LLM call (F-34). Normal synth is 10–40s;
 * this only trips on a stalled endpoint, turning an infinite hang into a
 * retryable error. */
const SYNTH_TIMEOUT_MS = 180_000;

export interface SynthModel {
  apiKey: string;
  baseUrl: string;
  /** Provider preset id (selects the AI SDK package). */
  provider: string;
  model: string;
}

export interface SynthResult {
  ok: boolean;
  source?: string;
  site?: string;
  name?: string;
  summary?: string;
  /** Example args to verify the adapter with (from the trace). */
  testArgs?: Record<string, unknown>;
  error?: string;
  /** Static-lint warnings about the source (fragile selectors etc.), surfaced
   * to the agent so it can harden before relying on the adapter. */
  warnings?: string[];
}

const MAX_BODY_SAMPLE = 1800;
const MAX_HTML_SAMPLE = 6000;
const MAX_ENDPOINTS = 14;
const MAX_ACTIONS = 40;

const SYSTEM_PROMPT = `You are the opencli adapter synthesizer. Given one "explore" recording (the action sequence + captured XHR/Fetch endpoints and responses + a DOM snapshot), produce a **deterministic, LLM-free** adapter source that can then be re-run directly.

Output format (strict):
1. First, a single line in English describing the strategy you chose and why.
2. Then a \`\`\`js code block containing the complete, installable opencli adapter source.
3. Finally a \`\`\`json code block with a set of real example args used to **verify** the adapter (take real values from the recording, e.g. a real url / keyword); the keys must match args exactly, e.g. {"url":"https://...","limit":10}. Give {} if there are no args.

Adapter source spec (consistent with the marketplace). **Two shapes — if pipeline can do it, don't use func**: pipeline needs no "allow user scripts" toggle and is more robust; func only runs once the user has enabled that toggle. Most "navigate → fetch once → tidy up" flows can be expressed as a pipeline (an evaluate step can fetch an endpoint, read embedded JSON, querySelectorAll; when you need to expand something, \`.click()\` the element inside evaluate then follow with a \`{ wait: { time: 1 } }\` step — pipeline has no standalone click step; just make sure you finally return an array of objects).

A) pipeline (preferred):
\`\`\`js
import { cli } from '@jackwener/opencli/registry';
cli({
  site: 'zhihu', name: 'hot', access: 'read', description: '知乎热榜', domain: 'www.zhihu.com',
  args: [{ name: 'limit', type: 'int', default: 20, help: 'count' }],
  columns: ['title', 'url'],
  pipeline: [
    { navigate: 'https://www.zhihu.com' },                 // open the host page (with the logged-in session)
    { evaluate: '(async () => { const r = await fetch("https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50", {credentials:"include"}); const d = await r.json(); return (d.data||[]).map(it => ({ title: it.target.title, url: "https://www.zhihu.com/question/" + it.target.id })); })()' },  // fetch data, return an array of objects
    { limit: '\${{ args.limit }}' },
  ],
});
\`\`\`
- Optional shaping: \`{ map: { title: '\${{ item.title }}', url: '\${{ item.url }}' } }\`; optional truncation: \`{ limit: '\${{ args.limit }}' }\` (\${{ }} is expression syntax, can use args.* / item.* / index).
- A purely public API (no logged-in session/page needed) can skip navigate and go straight to \`{ fetch: { url: '...' } }\` — fully tab-less, the leanest option.
- Supported steps: fetch / navigate / evaluate / map / filter / sort / transform / select / limit / paginate / wait (no click step; to expand/wait, do it inside evaluate or add \`{ wait: { time: N } }\`). The JS inside an evaluate step follows the same rules as the "func conventions" below (scope / defensive reads / robust selectors).

B) func (only when a pipeline can't express it — multiple navigations, page.autoScroll, imperative cross-step logic):
\`\`\`js
import { cli } from '@jackwener/opencli/registry';
cli({
  site: '<site lowercase id>', name: '<command name, lowercase + underscores>', access: 'read',
  description: '<one-line description>', domain: '<main domain>',
  args: [{ name: 'url', type: 'string', required: true, help: '...' }],
  columns: ['rank', '...'],
  func: async (page, kwargs) => { /* see func conventions below */ },
});
\`\`\`

Strategy selection (look at the recording evidence, highest to lowest priority — earlier is more robust; DOM scraping breaks most easily when a site redesigns, so avoid it when you can):
- **Direct endpoint fetch (most robust, preferred)**: if the recording has an XHR/Fetch endpoint that returns the business data directly (JSON), reproduce it — **prefer building it as a pipeline**: \`{ navigate: '<host page URL>' }\` then \`{ evaluate: 'fetch("<endpoint URL>",{credentials:"include"}).then(r=>r.json()).then(d => (d.data||[]).map(...))' }\`, then map/limit. Carries the user's logged-in session, zero LLM, **depends on no class at all**. (See most zhihu/* commands in the marketplace, e.g. zhihu/hot fetches \`/api/v3/feed/topstory/hot-lists/total\` directly.)
- **Page-embedded structured data / client-side storage (next most robust)**: data is often hidden in structured form in the HTML or in browser storage — **JSON-LD** (\`<script type="application/ld+json">\`, schema.org), framework-embedded state (\`__NEXT_DATA__\` / \`__NUXT__\` / \`__APOLLO_STATE__\` / \`__INITIAL_STATE__\` / \`<script type="application/json">\`), OG/Twitter meta, and **IndexedDB / localStorage** (an SPA often caches the full dataset here — more complete and stable than the DOM, and unaffected by virtual lists). After goto, \`page.evaluate\` reads it out and JSON.parse (for IndexedDB use open→transaction→get, remember to return a Promise), then maps it into columns — semantic keys that don't break when a style class is renamed. (During explore, use find_structured_data to scan it all out in one shot.)
- **Signed / one-time tokens**: when the endpoint URL/params contain a signature/token that changes each time (\`xsec_token\`, \`sign\`, \`nonce\`, \`_t\`, a long hex/base64, or anything named like sig/sign/token/timestamp), **do not hardcode that URL** (it's one-time and will expire). Instead: \`navigate\` to the host page first, then inside the page \`fetch(relative path, {credentials:"include"})\` to re-run it (the browser/page attaches the cookies/signature headers automatically); if the signature is computed on the fly by page JS, trigger a page action so it sends the request itself, then read the result. When a GraphQL persisted-query replay reports PersistedQueryNotFound, send the full query text instead.
- **DOM scraping (last resort)**: only when the data lives solely in the rendered DOM. \`await page.goto(url)\`, if needed \`await page.wait({time:2})\` / \`page.autoScroll(...)\`, then \`page.evaluate\` to scrape. **Selectors MUST be stable ones** (this is where an adapter rots most easily):
  - 🚫 **Never use classes that look compiled/obfuscated / random** (like \`.YzCcne\`, \`.tF2Cxc\` — meaningless short random strings) — they almost always break when the site re-publishes.
  - ✅ Prefer **stable semantic anchors** (strong to weak): \`[data-testid]\` / \`[data-*]\` / \`[itemprop]\` / \`[jsname]\`; \`[role=...]\` / \`[aria-label]\` / \`[alt*="..."]\`; semantic tags (\`article\`/\`h1\`-\`h3\`/\`time\`/\`a[href]\`); stable \`href\`/url shapes (\`a[href*="/question/"]\`); and **structural relationships + visible-text anchoring** (locate a block by its visible text/heading first, then take its parent/sibling nodes). Attributes can use \`*=\` substring matching, but the substring itself must be stable and semantic.
  - ✅ The page already has the **\`__loc\`** robust locator helper injected (equivalent to Playwright getByRole/getByText, usable directly inside func / evaluate): \`__loc.byRole('heading',{name:/AI Overview/i})\`, \`__loc.byText('text',{tag:'h3'})\`, \`__loc.units(['article','[role=listitem]','a[href*="/q/"]'])\` (returns repeated units — **from stable to weak, takes the first group that matches ≥2 elements**; for a single-element list just use query_dom / first), \`__loc.first(unit,['h3','[role=heading]','a[href]'])\`, \`__loc.field(unit,'a')\`/\`__loc.attr(unit,'a','href')\`. **Give each field 2–3 candidates from stable to weak** with \`__loc.first\` as a fallback — when one anchor breaks on a redesign the others still match (cheap self-healing).
  - 🔁 **Virtual lists / infinite scroll**: if the DOM only holds a small visible slice (\`data-virtual-list\` / \`role=feed\` / list items with an incrementing key), first see whether you can get the full set via ① the endpoint or ② IndexedDB; only when DOM-only, use **func** (not a single-step pipeline): prefer \`await page.autoScroll({ times, delayMs })\` to trigger lazy loading; when you need to dedup-and-accumulate by a stable key, hand-write a \`scrollBy\`/\`scrollIntoView\` loop until no new items appear, then return.

**Write adapters (access:'write')**: when the input carries a "captured write request" (the agent actually performed it once via capture_submission and the request was neutralized before sending), synthesize an \`access:'write'\` adapter that **reproduces** that request. Usually a one-step pipeline does it: \`{ navigate: '<host page>' }\` then \`{ evaluate: 'fetch("<endpoint relative path>",{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body: JSON.stringify({...})}).then(r=>r.json())' }\`. Key points: ① **relative path + credentials:"include"**, and **never hardcode** cookie / authorization / one-time CSRF (the capture redacted them to \`<redacted>\`) — the browser/page attaches these automatically; ② if the body has a CSRF/token field that the page computes fresh, read it from the DOM (\`meta[name=csrf-token]\`) or an endpoint inside the same evaluate first, then splice it into the body — don't use the stale value from the capture; ③ turn the fields the user needs to pass in (comment text, target id, etc.) into **args** and parameterize them into the body; ④ for GraphQL send the full \`{query,variables}\`, taking the mutation name from the operationName in the capture. **A write adapter is NOT auto-verified during explore** (it has real side effects); its state is "untested", and verification is left to the user calling it in conversation and going through the write confirmation — that's correct, don't actually send the request during synthesis just to "verify". ⑤ For **sensitive sites** — banking / payments / posting / deletion — add \`confirmBeforeUse: true\` to the write adapter's \`cli({...})\`, so every call prompts the user to confirm first (even if the user has enabled auto mode).

func / evaluate conventions (apply to both the func body and a pipeline evaluate step):
- The func signature is fixed as \`async (page, kwargs) => {...}\`, returning an **array of objects**, each object's keys matching columns exactly.
- page is opencli's IPage: has goto/evaluate/wait/autoScroll/getCookies, etc. page.evaluate takes a JS string (an IIFE or \`async () => {...}\`), executes it in the page's MAIN world, and returns a serializable result.
- Use kwargs to read the parameters (e.g. kwargs.url, kwargs.limit) and do basic validation.
- ⚠️ **page.evaluate scope**: its string runs in the [page world] and **cannot see the func's variables** (kwargs, limit, url, selector, etc.). To use a parameter, [splice it into the string] (\`'...' + JSON.stringify(kwargs.limit) + '...'\`) or process it with JS **after evaluate returns** the array (\`rows.slice(0, kwargs.limit)\`). **Never** write limit/kwargs directly inside the evaluate string — otherwise \`ReferenceError: limit is not defined\`.
- ⚠️ **Defensive reads**: querySelector may be null — before reading text/attributes, guard against null (\`el?.textContent?.trim() ?? ''\`, \`a?.href ?? ''\`), use \`Array.from(root.querySelectorAll(sel)).map(...)\` for lists, and don't read \`.length\` directly off a result that may be null.
- ⚠️ **func re-run semantics (trampoline)**: after each \`await page.goto(...)\` in a func, the whole func is **re-executed from the top** (the runner re-injects it). Therefore: ① **never put page.goto inside a paginate/loop** — paginate via an in-page \`fetch(next-page URL, {credentials:"include"})\` + \`new DOMParser().parseFromString(html, "text/html")\` parse, or use the endpoint's own paging params; ② multiple gotos must **advance monotonically and be guarded**: \`if (!location.href.includes("target-path-fragment")) await page.goto(...)\` (skip if already on the target page), otherwise it navigates back and forth up to the re-injection limit; ③ for a write operation, **never navigate again after the side effect happens** (a re-run would repeat the side effect).
- **Grab what's there, don't throw wholesale**: when some part of the task (e.g. an AI overview) isn't present on this page, just leave that field empty; only \`throw new Error('...')\` when [absolutely no data was obtained].
- Only use real endpoints/selectors that appeared in the recording — don't make them up.
- **Cover every part the task requires**: besides the main list, if the task also asks for accompanying content (e.g. AI overview / answer box / related questions / reference links), you must scrape those into the result too — as extra fields or extra rows (and reflect them in columns); don't scrape only the main list and drop these.
- If the input (task/prompt) carries an **extraction snippet that already works on the page** (validated by the agent with eval_js), **prefer adopting it directly** as the body of func's page.evaluate — don't start from scratch, it's already been proven to get the right data.
- **Multi-source fallback (more durable)**: if the same data has more than one viable source (e.g. both an endpoint and DOM scraping), try each in one **single** adapter, ordered by stability, returning the first non-empty result with complete fields (\`try { const r = await fromApi(); if (r && r.length) return r; } catch (e) {} return fromDom();\`) — when one path breaks on a redesign the adapter still works. Only add this when multiple sources genuinely exist; don't force it for a single source.

Output quality (get this right during synthesis too):
- **description must be searchable**: put the **site's common names (both Chinese and English, e.g. 「微博 weibo」「领英 linkedin」「小红书 xiaohongshu」) + main use-case keywords** in the \`description\` — \`find_adapters\` matches on it, so don't just write the in-site English name.
- **Enum parameters** (an arg with a finite set of options — sort / filter / type / section, etc.): in that arg's \`help\` spell out **where the valid values come from** (priority: endpoint > page \`<select>\`/radio DOM > a fixed enum list), don't just write a vague sentence — record the **method**, not the dead values (values change, the method endures). If there's cascading (B only appears after A is chosen), note the dependency chain in help. Let the caller self-check/extend the value set.
- **Pagination**: if a list-type adapter supports paging, express it with the pipeline \`paginate\` step or a page/offset/cursor arg, and it **must carry a termination condition** (\`paginate\` needs \`maxPages\` or \`until\`; a hand-written loop must "stop when the next page is empty") — **an unbounded paginate is never allowed** (it pages forever). Note the paging type clearly: endpoint-param paging / URL paging / DOM "load more" / cursor, plus where the next-page value comes from.
- **Output contract header comment**: add a \`/** ... */\` block above \`cli({...})\` with three items (write only **quantified things actually verified during explore**, don't speculate): **success criteria** (e.g. \`rows>=1\`, \`title/url non-empty rate=100%\` — quantified only, no descriptions like "result is correct"); **known limitations** (only what was actually hit, e.g. "requires login", "only the first 50"; a permission limit ≠ a technical failure — noting it counts as passing); **execution efficiency** (for the caller: **run serially, not in parallel** within the same browser; try 1–2 first before running a batch; persist row-by-row so it can resume from a checkpoint).
- ⚠️ **\`\${{ }}\` only in plain strings**: the pipeline's \`\${{ args.x }}\` is substituted by the engine inside **plain string** values (e.g. \`{ fetch: { url: '…?p=\${{ args.page }}' } }\`); **never write it inside a backtick template literal** (an evaluate that uses backticks and also writes \`\${{ args.x }}\` throws "Unexpected token" outright) — inside a template literal \`\${…}\` is JS interpolation, so \`\${{ }}\` gets parsed as an illegal object first. To use a parameter in evaluate, use a **single-quoted string + string concatenation** ("…" + JSON.stringify(kwargs.x) + "…").`;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s;
}

/** Compact the trace into a token-bounded digest for the synthesis prompt. */
export function buildTraceDigest(trace: Trace): string {
  const actions = trace.events.filter((e): e is TraceActionEvent => e.stream === 'action');
  const networks = trace.events.filter((e): e is TraceNetworkEvent => e.stream === 'network');
  const states = trace.events.filter((e): e is TraceStateEvent => e.stream === 'state');

  const parts: string[] = [];
  parts.push(`## Task\n${trace.task ?? '(not provided)'}`);
  if (trace.site) parts.push(`## Site\n${trace.site}`);
  if (trace.url) parts.push(`## Start URL\n${trace.url}`);

  // Dedup endpoints by method+path; keep the richest (has-body, JSON) first.
  const byKey = new Map<string, TraceNetworkEvent>();
  for (const n of networks) {
    let path = n.url;
    try {
      const u = new URL(n.url);
      path = `${u.origin}${u.pathname}`;
    } catch {
      /* keep raw */
    }
    const key = `${n.method} ${path}`;
    const prev = byKey.get(key);
    // Prefer the instance that actually carries a body.
    if (!prev || (!prev.responseBody && n.responseBody)) byKey.set(key, n);
  }
  const endpoints = [...byKey.values()]
    .sort((a, b) => (b.responseBody ? 1 : 0) - (a.responseBody ? 1 : 0))
    .slice(0, MAX_ENDPOINTS);

  if (endpoints.length) {
    const lines = endpoints.map((n, i) => {
      const head = `${i + 1}. ${n.method} ${n.url}\n   status=${n.status ?? '?'} type=${n.contentType ?? '?'}`;
      const body = n.responseBody
        ? `\n   response body sample: ${clip(n.responseBody, MAX_BODY_SAMPLE)}`
        : '';
      const reqBody = n.requestBody ? `\n   request body: ${clip(n.requestBody, 300)}` : '';
      return head + reqBody + body;
    });
    parts.push(`## Captured endpoints (${endpoints.length})\n${lines.join('\n')}`);
  } else {
    parts.push('## Captured endpoints\n(no XHR/Fetch — the data may live only in the DOM, consider DOM scraping)');
  }

  if (actions.length) {
    const lines = actions.slice(0, MAX_ACTIONS).map((a) => {
      const args = a.args ? clip(JSON.stringify(a.args), 200) : '';
      return `- ${a.tool}(${args}) → ${a.status}${a.resultDigest ? ` ${clip(a.resultDigest, 160)}` : ''}`;
    });
    parts.push(`## Action sequence\n${lines.join('\n')}`);
  }

  // Most recent / largest DOM snapshot, for the scrape fallback.
  const snap = states
    .filter((s) => typeof s.html === 'string' && s.html)
    .sort((a, b) => (b.html?.length ?? 0) - (a.html?.length ?? 0))[0];
  if (snap?.html) {
    parts.push(`## DOM snapshot (${snap.url ?? ''})\n${clip(snap.html, MAX_HTML_SAMPLE)}`);
  }

  return parts.join('\n\n');
}

/** Pull the adapter source: prefer an explicitly js/ts-tagged fence (so a
 * trailing ```json verify block isn't mistaken for the source); fall back to
 * the first fence of any kind, then the whole string. */
function extractSource(content: string): { source: string; summary: string } {
  const typed = /```(?:js|javascript|ts|typescript)\s+([\s\S]*?)```/.exec(content);
  const fence = typed ?? /```\s*([\s\S]*?)```/.exec(content);
  if (fence) {
    const summary = content.slice(0, fence.index).trim().split('\n').filter(Boolean).pop() ?? '';
    return { source: fence[1].trim(), summary };
  }
  return { source: content.trim(), summary: '' };
}

/** Pull a ```json fenced block as the verify args; {} on absence/parse error. */
function extractTestArgs(content: string): Record<string, unknown> {
  const m = /```json\s*([\s\S]*?)```/.exec(content);
  if (!m) return {};
  try {
    const v = JSON.parse(m[1].trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseField(source: string, field: string): string | undefined {
  const m = new RegExp(`${field}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(source);
  return m?.[1];
}

/** Declared arg names parsed from the source's `args: [...]` block. */
function parseArgNames(source: string): string[] {
  const block = /args\s*:\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
  const names: string[] = [];
  const re = /name\s*:\s*['"`]([A-Za-z_$][\w$]*)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) names.push(m[1]);
  return [...new Set(names)];
}

/** Static lint of synthesized source for durability smells (A3). High-precision
 * heuristics → returned as WARNINGS (not auto-repair, to avoid token churn on a
 * false positive): obfuscated/compiled class selectors (short, separator-free,
 * with an internal camel change or digit — the `.YzCcne`/`.tF2Cxc` rot source),
 * `:nth-child` data-row indexing, arg-leak (a func-scope name referenced inside
 * an evaluate STRING runs in the page world → guaranteed ReferenceError at
 * replay), and arg-wiring (a declared arg the source never reads — almost always
 * the explored value hardcoded in its place, so user input is silently ignored).
 * Broken selectors don't throw — they silently rot — so a static smell is the
 * only pre-replay signal. */
export function lintSource(source: string, testArgs?: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  // Scope the lint to actual selector STRINGS (args to querySelector/closest/…)
  // so camelCase method calls (.forEach/.innerHTML) aren't mistaken for classes.
  const selectorStrings: string[] = [];
  const re = /(?:querySelector(?:All)?|closest|matches)\s*\(\s*(['"`])([^'"`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) selectorStrings.push(m[2]);
  const blob = selectorStrings.join('  ');

  // Compiled/obfuscated class selectors rot on the next site build. Two shapes:
  // (a) separator-free short random (`.YzCcne` / `.tF2Cxc`); (b) CSS-modules /
  // styled-components hashed classes that DO carry separators — webpack
  // `[name]-module__[local]__[hash]`, `sc-<hash>`, `css-<hash>`. F-33: task-2
  // (GitHub search) used `.Content-module__Content__mHmep` etc. and the old
  // check bailed on any `-`/`_`, so it missed the whole CSS-modules family.
  const isHashSeg = (h: string): boolean => (/[a-z]/.test(h) && /[A-Z]/.test(h)) || /[0-9]/.test(h); // mixed-case or letter+digit
  const looksHashedModule = (c: string): boolean => {
    if (/-module__/.test(c)) return true; // webpack CSS Modules ([name]-module__…)
    if (/^sc-[A-Za-z]{5,}$/.test(c)) return true; // styled-components
    if (/^(?:css|jss)-?[a-z0-9]{5,}$/i.test(c)) return true; // emotion / jss
    // trailing __<hash>, but only in a compound class (has `-` or ≥2 `__`) so a
    // plain BEM `block__element` / `header__navButton` is NOT flagged.
    const m = /__([A-Za-z0-9]{4,10})$/.exec(c);
    return !!m && (/-/.test(c) || (c.match(/__/g) ?? []).length >= 2) && isHashSeg(m[1]);
  };
  const tokens = blob.match(/\.[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? [];
  const suspicious = [...new Set(tokens)].filter((t) => {
    const c = t.slice(1);
    if (/[-_]/.test(c)) return looksHashedModule(c); // CSS-modules / styled-components
    if (c.length < 5 || c.length > 8) return false;
    // internal lower→upper (hash-like; excludes PascalCase words + all-lower) or letter+digit mix
    return /[a-z][A-Z]/.test(c) || (/[0-9]/.test(c) && /[A-Za-z]/.test(c));
  });
  if (suspicious.length) {
    warnings.push(
      `Suspected compiled/obfuscated random class selectors (break easily on a redesign): ${suspicious.slice(0, 6).join(', ')} — switch to role/aria/semantic-tag/href/text anchors (verify with get_a11y_tree / query_dom)`,
    );
  }
  if (/:nth-child\(/.test(blob)) {
    warnings.push('Uses :nth-child to locate data rows (any change in row order scrapes the wrong one) — switch to content filtering or :has()');
  }

  const argNames = parseArgNames(source);

  // Arg-leak: scan evaluate string bodies (page.evaluate('...') / pipeline
  // `evaluate: '...'`). Template-literal `${...}` parts interpolate in func
  // scope before the string reaches the page, so they're stripped first.
  const evalBodies: string[] = [];
  const evalRe = /(?:\.\s*evaluate\s*\(|evaluate\s*:)\s*(['"`])([\s\S]*?)\1/g;
  let em: RegExpExecArray | null;
  while ((em = evalRe.exec(source))) evalBodies.push(em[2].replace(/\$\{[^}]*\}/g, ''));
  const leaked = new Set<string>();
  for (const body of evalBodies) {
    if (/\bkwargs\b/.test(body)) leaked.add('kwargs');
    for (const n of argNames) {
      // Bare use: not a property access (.n), not an object key (n:), not a
      // quoted string/JSON key ("n"), not an assignment/URL query param (n= —
      // that's the hardcoded VALUE, not a leak; == / === comparisons still hit).
      const bare = new RegExp(`(?<![.\\w$"'])${n}(?![\\w$]|\\s*:|\\s*=(?!=))`);
      // Declared inside the body (incl. destructuring span) or a REAL function
      // parameter (parens followed by =>, or a function declaration) — a bare
      // `f(0, n)` call argument must NOT count as a declaration.
      const declared = new RegExp(
        `(?:const|let|var)\\s+[^=;]*\\b${n}\\b|function\\s*\\w*\\s*\\([^)]*\\b${n}\\b[^)]*\\)|\\([^)]*\\b${n}\\b[^)]*\\)\\s*=>|\\b${n}\\s*=>`,
      );
      if (bare.test(body) && !declared.test(body)) leaked.add(n);
    }
  }
  if (leaked.size) {
    warnings.push(
      `The evaluate string references outer variables ${[...leaked].join(', ')} (it runs in the page world and can't see the func scope, so it will throw ReferenceError at runtime) — splice the value into the string, or process it after evaluate returns`,
    );
  }

  // evaluate(FN) instead of evaluate('STRING') (F-18): the runtime only supports
  // the string form — `page.evaluate(fn, ...args)` / `evaluate: () => {}` has its
  // fn (and any args) silently dropped → a null-crash downstream, not an error.
  // Flag a function passed where a code string belongs. A bare identifier/call
  // (`evaluate(code)` / `evaluate(build())`) is a legit string source and does
  // NOT match — only an inline function literal (async / function / arrow) does.
  const FN_START = String.raw`async\b|function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>`;
  const evalFn = new RegExp(String.raw`(?:\.\s*evaluate\s*\(|\bevaluate\s*:)\s*(?:${FN_START})`);
  if (evalFn.test(source)) {
    warnings.push(
      "page.evaluate / pipeline evaluate was passed a **function** (e.g. evaluate(() => {…})) — the runtime only supports the **string** form, so the function is silently dropped and crashes downstream on null; change it to evaluate('…code string…') (splice parameters into the string if needed)",
    );
  }

  // Arg-wiring: kwargs.n / kwargs['n'] (func) or args.n inside ${{ }} (pipeline).
  const unused: string[] = [];
  for (const n of argNames) {
    const used = new RegExp(
      `kwargs\\s*(?:\\.\\s*${n}\\b|\\[\\s*['"\`]${n}['"\`]\\s*\\])|args\\s*\\.\\s*${n}\\b`,
    ).test(source);
    if (used) continue;
    const tv = testArgs?.[n];
    const hard =
      typeof tv === 'string' && tv.length >= 4 && source.includes(tv)
        ? ` (and the example value "${tv.slice(0, 60)}" is hardcoded in the source)`
        : '';
    unused.push(`"${n}"${hard}`);
  }
  if (unused.length) {
    warnings.push(
      'Declared args that the source never uses: ' +
        unused.join(', ') +
        ' — changing them will have no effect; wire them up with kwargs.<name> or ${{ args.<name> }}',
    );
  }

  // ⑦ Pagination must terminate: a pipeline `paginate:` config with no
  // maxPages / until (nor a hasMore/while stop) can page forever. High-precision
  // — only fires when a paginate config is present and its window shows no bound.
  const pag = /\bpaginate\b\s*:?\s*\{/g;
  let pm: RegExpExecArray | null;
  let unbounded = false;
  while ((pm = pag.exec(source))) {
    const win = source.slice(pm.index, pm.index + 320);
    if (!/\b(maxPages|until|hasMore|hasNext|while|stop)\b/.test(win)) unbounded = true;
  }
  if (unbounded) {
    warnings.push(
      'paginate has no termination condition (maxPages / until) — it may page forever; add a maxPages cap or an until (stop when the next page is empty)',
    );
  }

  // Pipeline `${{ expr }}` substitution belongs in PLAIN-string values (the
  // engine substitutes them before use). Inside a backtick TEMPLATE LITERAL, JS
  // evaluates `${...}` interpolation FIRST at register time → `${{ args.x }}`
  // parses as an invalid object literal → "Unexpected token '.'" (F-32). Track
  // template state in a single pass; flag a `${{` seen while inside a template
  // (a `${{` inside a '...'/"..." pipeline string has even backticks before it,
  // so it stays out of a template and isn't flagged).
  let inTemplate = false;
  let templExprLeak = false;
  for (let k = 0; k < source.length; k++) {
    const ch = source[k];
    if (ch === '`' && source[k - 1] !== '\\') inTemplate = !inTemplate;
    else if (inTemplate && ch === '$' && source[k + 1] === '{' && source[k + 2] === '{') {
      templExprLeak = true;
      break;
    }
  }
  if (templExprLeak) {
    warnings.push(
      '`${{ ... }}` was written inside a backtick template literal (e.g. evaluate: `…${{ args.x }}…`) — inside a template `${…}` is JS interpolation, so `${{ }}` gets parsed as an illegal object first and throws "Unexpected token" at runtime; to use a parameter in evaluate switch to a **single-quoted string + concatenation** ("…" + kwargs.x + "…"), or keep `${{ }}` only in plain-string pipeline steps',
    );
  }

  return warnings;
}

export async function synthesizeAdapter(
  trace: Trace,
  model: SynthModel,
  opts: {
    signal?: AbortSignal;
    repair?: { prevSource: string; error: string };
    /** Rows the agent extracted live with eval_js — the target the adapter must
     * reproduce. Evidence-first synthesis (D4): synthesize against the observed
     * DATA, not just the action log. */
    expectedSample?: unknown[];
    /** The eval_js CODE that produced expectedSample. Fed verbatim so synthesis
     * adopts the proven snippet even when the agent forgets to paste it into
     * notes (V2.1/V2.2 lesson: never rely on the model relaying evidence). */
    provenSnippet?: string;
    /** Write requests captured (and neutralized) via capture_submission — the
     * real evidence for synthesizing a WRITE adapter (F-29 constructive fix). */
    capturedSubmissions?: CapturedSubmission[];
  } = {},
): Promise<SynthResult> {
  const digest = buildTraceDigest(trace);
  const sampleBlock = opts.expectedSample?.length
    ? `\n\n## Expected output sample (already verified on the page with eval_js, ${opts.expectedSample.length} items)\nThe synthesized adapter **must be able to reproduce these values** (field names may differ, but the content must match):\n${clip(
        JSON.stringify(opts.expectedSample.slice(0, 8), null, 2),
        2500,
      )}`
    : '';
  const snippetBlock = opts.provenSnippet
    ? `\n\n## Extraction code that already works on the page (proven by eval_js; the expected sample above is exactly what it returned)\n\`\`\`js\n${clip(
        opts.provenSnippet,
        4000,
      )}\n\`\`\`\n**Prefer adopting this code as-is** as the body of evaluate / func (splice parameters into the string when needed); don't start from scratch.`
    : '';
  const submissionBlock = opts.capturedSubmissions?.length
    ? `\n\n## Captured write request (proven via capture_submission: actually performed once, but the request was neutralized and **never sent to the server** — this is the write operation to synthesize)\nSynthesize an \`access:'write'\` adapter to **reproduce** these requests (endpoint / method / body fields; for GraphQL look at the mutation name). The cookie/authorization headers are redacted to \`<redacted>\` — **don't hardcode them**; rely on a relative path + \`credentials:"include"\` to let the browser attach them; parameterize the fields the user passes into args.\n${clip(
        JSON.stringify(opts.capturedSubmissions.slice(0, 5), null, 2),
        3000,
      )}`
    : '';
  const base = digest + sampleBlock + snippetBlock + submissionBlock;
  const userContent = opts.repair
    ? `${base}\n\n## Previous adapter version (needs fixing/improving — modify it in place)\n\`\`\`js\n${clip(opts.repair.prevSource, 6000)}\n\`\`\`\n\n## Problem with the previous version\n${clip(opts.repair.error, 1500)}\n\nFix it accordingly and re-emit the corrected source + verify args in the same output format. Common pitfalls to check: ① referenced outer variables like kwargs/limit/url inside the page.evaluate string (→ splice into the string or process after it returns); ② querySelector not null-guarded causing a null error; ③ throwing wholesale when a part is missing (→ grab what's there); ④ incomplete result that dropped content the task required (e.g. the AI overview body / reference links); ⑤ page.goto placed inside a loop/paginate (→ switch to in-page fetch + DOMParser), or multiple gotos missing a URL guard (→ add a location.href check).`
    : base;
  log(
    'explore',
    `synthesize${opts.repair ? '(repair)' : ''}: trace=${trace.traceId} input=${userContent.length} chars`,
  );
  // Bound the synth LLM call. `chatCompletion`'s fetch has no timeout, and this
  // path passed no signal — so a stalled endpoint hung the whole agent loop
  // indefinitely (F-34: a ProductHunt synth hung ~19min, orphaning the tool
  // call → the model then hallucinated "I don't have synthesize_adapter" and
  // gave up). One 8192-token completion needs << 3min; on timeout we return a
  // retry-friendly error and the agent re-calls synthesize_adapter (same name =
  // repair round). Combined with opts.signal so Stop still aborts it too.
  const timeoutSignal = AbortSignal.timeout(SYNTH_TIMEOUT_MS);
  let resp;
  try {
    resp = await chatCompletion({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      provider: model.provider,
      signal: anySignal([opts.signal, timeoutSignal]),
      body: {
        model: model.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        // 8192: a repair round embeds up to 6000 chars of previous source — 4096
        // completion tokens risked truncating the regenerated adapter mid-fence.
        max_tokens: 8192,
      },
    });
  } catch (e) {
    warn('explore', 'synthesize chatCompletion failed', e);
    // Our timeout fired (not the caller's Stop) → tell the agent to retry.
    if (timeoutSignal.aborted && !opts.signal?.aborted) {
      return {
        ok: false,
        error: `Synthesis timed out: the model did not respond within ${Math.round(
          SYNTH_TIMEOUT_MS / 1000,
        )}s. Retry by calling synthesize_adapter again with the same name (the tool is available; only this request timed out).`,
      };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const content = resp.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) return { ok: false, error: 'synthesis returned empty content' };

  const { source, summary } = extractSource(content);
  const testArgs = extractTestArgs(content);
  const site = parseField(source, 'site');
  const name = parseField(source, 'name');
  if (!site || !name || !/cli\s*\(/.test(source)) {
    return {
      ok: false,
      error: 'synthesis output is not a recognizable cli({...}) adapter',
      summary,
    };
  }
  const warnings = lintSource(source, testArgs);
  log('explore', `synthesize ok → ${site}/${name} (${source.length} chars)`);
  return {
    ok: true,
    source,
    site,
    name,
    summary,
    testArgs,
    warnings: warnings.length ? warnings : undefined,
  };
}
