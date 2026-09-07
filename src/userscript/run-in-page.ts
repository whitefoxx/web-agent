/**
 * In-page adapter runtime — the Phase B (func-type hot-plug) execution core.
 *
 * This code runs INSIDE a target tab's USER_SCRIPT world (injected via
 * chrome.userScripts), where:
 *   - the page's DOM is shared with MAIN world, so DOM-only helpers
 *     (wait/scroll/autoScroll) run LOCALLY — no RPC, no eval boundary;
 *   - page.evaluate is RPC'd to the SW so it executes via CDP in MAIN world.
 *     We can't run it locally: USER_SCRIPT and MAIN have isolated `globalThis`
 *     bindings, so opencli adapters that read page bootstrap globals
 *     (window.ytInitialData, window.ytcfg, window.__INITIAL_STATE__, …) would
 *     get `undefined` if evaluate stayed in-world (see docs/adapter-hot-plug.md
 *     §10.2). Routing through CDP matches the pre-Phase-B semantics exactly.
 *   - chrome.* is NOT available, so page.goto/getCookies/screenshot/cdp/... are
 *     RPC'd to the service worker (which holds chrome.tabs / chrome.cookies /
 *     chrome.debugger) via the injected `rpc` transport.
 *
 * opencli funcs assume a controller OUTSIDE the page (goto then scrape). Running
 * the func INSIDE the page breaks `goto` (navigation destroys this context). We
 * bridge that with a NAVIGATE-THEN-REINJECT TRAMPOLINE: page.goto(url) checks
 * if we're already at url; if not, it RPCs the SW to navigate and throws
 * NAVIGATE_RESTART. The SW navigates the tab, then re-injects this runner; on
 * the second run the func re-executes from the top, goto sees it's already at
 * url and returns, and the func proceeds to scrape. This handles no-goto funcs
 * (~75% of the corpus) and single-goto-at-top funcs (~24%) with ZERO per-adapter
 * conversion. Multi-goto / interleaved funcs (~1%) fall back to the CDP PageShim.
 *
 * Everything here is unit-testable in node: the `rpc` transport and (optionally)
 * the DOM globals are injected, so tests use fakes. The real wiring
 * (chrome.userScripts.execute + onUserScriptMessage) lives in the SW + a tiny
 * bootstrap, not here.
 */

import { stripModuleSyntax } from '../sandbox/eval-core';
import { buildAdapterScope } from '../runtime/adapter-scope';

/** Thrown by page.goto when a navigation is needed. The top-level runner maps
 * this to a "navigating, will resume after reinject" outcome rather than an
 * error.
 *
 * Why an Error subclass with BOTH a tag property AND the marker embedded in
 * .message (used to be a bare plain object): some adapters wrap page.goto in
 * try/catch and re-throw — e.g. zhihu/answer-detail does
 *
 *   try { await page.goto(url); }
 *   catch (err) { throw new CommandExecutionError(
 *     `Failed to open Zhihu answer ${id}: ${err.message ?? String(err)}`); }
 *
 * With a plain-object throw, `String(err)` returned `[object Object]` (useless
 * for debugging) AND the runner lost the navigate signal entirely. Making this
 * an Error fixes the stringify; embedding the marker in `.message` lets
 * findNavigateRestart() recover the URL even from a wrapping adapter's
 * `${err.message}` interpolation — see docs/adapter-hot-plug.md §10.10.
 *
 * Detection still uses the tag property (not instanceof) so it works across
 * the eval boundary where realm-identity is iffy. */
export const NAVIGATE_RESTART = '__web_navigate_restart__';
export interface NavigateRestart {
  [NAVIGATE_RESTART]: true;
  url: string;
}
export class NavigateRestartError extends Error implements NavigateRestart {
  readonly [NAVIGATE_RESTART] = true as const;
  readonly url: string;
  constructor(url: string) {
    // Marker embedded in the message so a wrapping adapter that re-throws
    // with `${err.message}` interpolation preserves enough signal for
    // findNavigateRestart to pull the URL back out.
    super(`${NAVIGATE_RESTART}|${url}`);
    this.name = 'NavigateRestart';
    this.url = url;
  }
}
export function isNavigateRestart(v: unknown): v is NavigateRestart {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[NAVIGATE_RESTART] === true;
}

/** Find a NavigateRestart marker even when an adapter wrapped our throw.
 *
 * Three detection paths, in order:
 *   1. The value itself is tagged (the no-try/catch happy path).
 *   2. The value (or any `.cause`) is tagged (modern `new Error(msg, {cause})`).
 *   3. The value's `.message` string contains the embedded URL marker
 *      (catches `throw new XxxError(\`prefix: ${err.message}\`)` — the zhihu
 *      pattern). Capped recursion depth guards against pathological causes.
 *
 * Without (3), zhihu/answer-detail's `catch (err) { throw new
 * CommandExecutionError(\`Failed to open Zhihu answer ${id}: ${err.message}\`) }`
 * would defeat the trampoline — the runner would see an unrelated error and
 * never trigger the navigate. */
export function findNavigateRestart(e: unknown, depth = 0): NavigateRestart | null {
  if (depth > 6) return null;
  if (isNavigateRestart(e)) return e;
  if (e && typeof e === 'object') {
    const cause = (e as { cause?: unknown }).cause;
    if (cause != null) {
      const fromCause = findNavigateRestart(cause, depth + 1);
      if (fromCause) return fromCause;
    }
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string') {
      // Match the embedded form `__web_navigate_restart__|<url>` and
      // grab the URL up to the next whitespace/quote so a re-throw with a
      // suffix doesn't break extraction.
      const m = msg.match(new RegExp(`${NAVIGATE_RESTART}\\|([^\\s"'\`]+)`));
      if (m) return { [NAVIGATE_RESTART]: true, url: m[1] };
    }
  }
  return null;
}

/** Render an unknown thrown value as a debuggable string.
 *
 * Why not `String(e)`: a plain-object throw becomes `[object Object]`, which is
 * actively misleading in logs and surfaced errors. We fall back to
 * JSON.stringify so the keys/values are at least visible, then to String() as
 * a last resort (BigInt, circular refs, …). */
export function fmtError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e;
  if (e == null) return String(e);
  try {
    const s = JSON.stringify(e);
    if (s && s !== '{}' && s !== 'null') return s;
  } catch {
    // circular ref, BigInt, etc. — fall through
  }
  return String(e);
}

/** page.* methods that must be RPC'd to the SW (need chrome.* / CDP / MAIN world).
 * Everything else (wait/scroll/autoScroll/getCurrentUrl/getAttachments) runs
 * locally — those are DOM-only and the DOM is shared across worlds.
 * Kept as data so it's greppable + testable. */
export const RPC_METHODS = new Set([
  'goto', // special-cased (trampoline) but still RPCs the navigate
  // evaluate routes through CDP so adapter scripts see MAIN-world globals
  // (ytInitialData, ytcfg, __NUXT__, __INITIAL_STATE__, …). USER_SCRIPT
  // world has its own isolated globalThis — see file header.
  'evaluate',
  'getCookies',
  'screenshot',
  'cdp',
  'installInterceptor',
  'getInterceptedRequests',
  'downloadFile',
  'nativeType',
  'nativeClick',
  'nativeKeyPress',
  'setFileInput',
  // The func's GLOBAL fetch, proxied to the SW so browser:false adapters get
  // CORS-free HTTP (host_permissions: <all_urls>) instead of being bound by the
  // host page's CORS. Installed as a globalThis.fetch shim in runAdapterInPage
  // for browser:false — see docs/tests findings F-5.
  'fetch',
  // page.tabs(): enumerate browser tabs (chrome.tabs.query via SW) so adapters can
  // find a result opened in a NEW tab — e.g. gemini deep-research-result exports to
  // a Google Doc in a new tab and diffs tabs before/after. F-21.
  'tabs',
]);
// NOTE: `captureNetwork` is deliberately NOT RPC-able — it returns
// `{ body: Promise<T> }` (a two-phase armed capture), which doesn't serialize
// across the message boundary. The ~5 corpus adapters that use it fall back to
// the CDP PageShim path. A func calling page.captureNetwork in-page will get a
// clear "not a function" rather than a silently broken capture. The
// rpc-server's SERVER_METHODS must stay in lockstep with this set (a test
// asserts they're equal).

export type Rpc = (method: string, args: Record<string, unknown>) => Promise<unknown>;

export interface LocalPageOptions {
  /** RPC transport to the SW (correlates request/response). */
  rpc: Rpc;
  /** Current tab id (passed through on RPCs that need it). */
  tabId?: number;
  /** User-attached files, surfaced via page.getAttachments(). */
  attachments?: File[];
  /** URL the SW already navigated to as part of this adapter run (from a
   * prior runner instance's NAVIGATE_RESTART). When the adapter's first
   * `page.goto(url)` matches this, the trampoline returns immediately
   * without RPC — even if `location.href` differs because the server
   * redirected (zhihu `/answer/<aid>` → `/question/<qid>/answer/<aid>`).
   * Consumed once: subsequent gotos go through normal trampoline.
   * See adapter-hot-plug.md §10.11. */
  lastNavigatedUrl?: string;
  /** DOM/global overrides for testing. Defaults to the ambient globals. */
  env?: {
    location?: { href: string };
    evalFn?: (code: string) => unknown;
    setTimeout?: typeof setTimeout;
  };
}

/** True if `current` is the same logical page as `requested`: same origin +
 * pathname, and every search-param the adapter asked for is present in the
 * current URL with the same value. Hashes are ignored; extra params in
 * `current` (tracking, `xsec_source`/`xsec_token`, etc.) are tolerated.
 * Falls back to strict string equality on malformed input.
 *
 * Exported for tests; used by the navigate trampoline in makeLocalPage. */
export function sameLogicalPage(current: string, requested: string): boolean {
  if (current === requested) return true;
  try {
    const a = new URL(current);
    const b = new URL(requested);
    if (a.origin !== b.origin) return false;
    if (a.pathname !== b.pathname) return false;
    for (const [k, v] of b.searchParams) {
      if (a.searchParams.get(k) !== v) return false;
    }
    return true;
  } catch {
    return current === requested;
  }
}

/** Auto-IIFE-wrap a JS string before local eval, mirroring PageShim.wrapForEval
 * so adapters that pass a bare arrow/function/expression all work. */
function wrapForEval(js: string): string {
  if (typeof js !== 'string') return 'undefined';
  const code = js.trim();
  if (!code) return 'undefined';
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) return `(${code})()`;
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;
  return code;
}

/**
 * Build the `page` object handed to an adapter's func when it runs in-page.
 * Local methods touch the DOM directly; RPC methods delegate to the SW.
 */
export function makeLocalPage(opts: LocalPageOptions): Record<string, unknown> {
  const { rpc, tabId, attachments = [] } = opts;
  const loc = opts.env?.location ?? (typeof location !== 'undefined' ? location : { href: '' });
  // Mutable so the trampoline can consume it on first match — see goto below.
  let lastNavigatedUrl = opts.lastNavigatedUrl;
  // Indirect eval via globalThis.eval runs in global scope; in the USER_SCRIPT
  // world its CSP allows it. Using globalThis.eval (not the bare `eval` /
  // `(0,eval)` form) avoids bundler direct-eval special-casing. `evalFn`
  // override lets tests substitute a sandboxed evaluator.
  const globalEval = (globalThis as { eval?: (c: string) => unknown }).eval;
  const doEval =
    opts.env?.evalFn ?? ((code: string) => (globalEval ? globalEval(code) : undefined));
  const timer = opts.env?.setTimeout ?? setTimeout;
  const sleep = (ms: number) => new Promise<void>((r) => timer(() => r(), ms));

  const page: Record<string, unknown> = {
    tabId,

    // evaluate is added by the RPC_METHODS loop below — it goes through the SW
    // so adapter scripts execute in MAIN world (see file header). Keeping it
    // local would mean reading window.<global> from USER_SCRIPT world's
    // isolated binding, which is `undefined` for every page bootstrap.

    async wait(
      arg: { time?: number; selector?: string; text?: string; timeout?: number } | number,
    ) {
      const o = typeof arg === 'number' ? { time: arg } : (arg ?? {});
      if (o.selector || o.text) {
        const timeoutMs = typeof o.timeout === 'number' ? o.timeout : 10_000;
        const sel = o.selector ? JSON.stringify(o.selector) : 'null';
        const txt = o.text ? JSON.stringify(o.text) : 'null';
        await doEval(
          wrapForEval(`
          new Promise((resolve) => {
            const sel = ${sel}, txt = ${txt};
            const hit = () => (sel && document.querySelector(sel)) ||
              (txt && (document.body && document.body.innerText || '').includes(txt));
            if (hit()) return resolve(true);
            const obs = new MutationObserver(() => { if (hit()) { obs.disconnect(); resolve(true); } });
            obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(false); }, ${timeoutMs});
          })`),
        );
        return;
      }
      const secs = typeof o.time === 'number' && Number.isFinite(o.time) ? Math.max(0, o.time) : 0;
      await sleep(secs * 1000);
    },

    // opencli aliases: millisecond sleeps.
    async waitFor(ms: number) {
      await sleep(typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0);
    },
    async waitForTimeout(ms: number) {
      await sleep(typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0);
    },

    // F-17: opencli's network-capture flow is installInterceptor → waitForCapture
    // → getInterceptedRequests. The CDP PageShim awaits a captureNetwork handle;
    // the userScripts path instead arms via installInterceptor (RPC'd to the CDP
    // shim, which accumulates matching responses) and reads them with
    // getInterceptedRequests — which CLEARS the buffer, so we must NOT poll it
    // here (that would consume the capture before the adapter reads it). So just
    // WAIT, giving the intercepted request(s) time to land (the adapter usually
    // scrolls right after to trigger them). `timeout` ≤60 is read as seconds
    // (opencli passes e.g. 5), else milliseconds; capped so a bad value can't
    // hang the run. Without this method the userScripts shim throws
    // "page.waitForCapture is not a function" (twitter notifications).
    async waitForCapture(timeout?: number) {
      const n = typeof timeout === 'number' && Number.isFinite(timeout) ? Math.max(0, timeout) : 3;
      await sleep(Math.min(n <= 60 ? n * 1000 : n, 10_000));
    },

    async autoScroll(o: { times?: number; delayMs?: number } = {}) {
      const times = o.times ?? 3;
      for (let i = 0; i < times; i++) {
        await doEval('window.scrollBy(0, Math.floor(window.innerHeight * 0.8))');
        await sleep(o.delayMs ?? 600 + Math.floor(Math.random() * 400));
      }
    },
    async scroll(_direction?: string, amount?: number) {
      await doEval(`window.scrollBy(0, ${typeof amount === 'number' ? amount : 600})`);
    },

    // Async to match PageShim.getCurrentUrl's `Promise<string | null>` shape —
    // some adapters (zhihu/answer-detail) chain `.catch(() => '')` on it, and
    // `.catch` on a sync string is undefined → "page.getCurrentUrl(...).catch
    // is not a function". The DOM read itself is sync; we just wrap. See
    // adapter-hot-plug.md §10.12.
    async getCurrentUrl(): Promise<string> {
      return loc.href;
    },

    getAttachments(): File[] {
      return attachments.slice();
    },

    /** Navigate trampoline — see file header.
     *
     * The "are we already there" check has to be LENIENT, not strict-equal:
     * most real sites (xiaohongshu, twitter, youtube, …) rewrite the URL
     * after navigation by adding tracking query params (xsec_source,
     * xsec_token, utm_*) and/or hashes. Strict `loc.href === url` would
     * loop forever — reinject after reinject, all landing at the same
     * effectively-correct page but a URL string the adapter doesn't
     * recognise as "there".
     *
     * Lenient rule: same origin + same pathname + requested URL's
     * searchParams are a SUBSET of current location's. Hashes ignored.
     * Catches:
     *   asked  https://x.com/a?q=1
     *   landed https://x.com/a?q=1&xsec_token=abc#init   ← SAME PAGE
     */
    async goto(url: string): Promise<void> {
      if (sameLogicalPage(loc.href, url)) return; // already here (post-reinject): no-op
      // Post-reinject server-redirect path: the SW already navigated to `url`
      // on our behalf, but the server redirected to a different canonical URL
      // (zhihu `/answer/<aid>` → `/question/<qid>/answer/<aid>`). sameLogicalPage
      // rejects path mismatches, but we KNOW we asked for this URL — accept it.
      // Consume the hint so a second adapter goto goes through the trampoline
      // normally.
      if (lastNavigatedUrl && lastNavigatedUrl === url) {
        lastNavigatedUrl = undefined;
        return;
      }
      await rpc('goto', { url, tabId });
      // Stop the func; the SW will re-inject after the tab loads. Throw an
      // Error subclass (not a plain object) so adapters that wrap goto in
      // try/catch get a readable stringification + a recoverable marker
      // even when they re-throw — see NavigateRestartError doc.
      throw new NavigateRestartError(url);
    },
  };

  // RPC delegations (everything that needs chrome.* / CDP).
  for (const method of RPC_METHODS) {
    if (method === 'goto') continue; // already defined above
    page[method] = (...args: unknown[]) => rpc(method, { args, tabId });
  }

  return page;
}

/** Eval an adapter source KEEPING the func closure (the opposite of eval-core's
 * serialize-and-drop). Only safe in the venue where func will run. Returns the
 * live cli() definitions. `evalFn` override lets tests inject the constructor. */
export function evalAdapterKeepingFuncs(
  src: string,
  evalFn?: (names: string[], body: string) => (...vals: unknown[]) => void,
): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  // Shared scope: REAL errors (so dispatcher instanceof works), REAL utils
  // (real htmlToMarkdown / mapConcurrent / login-wall sniffing), real `log`.
  // See src/runtime/adapter-scope.ts + hot-plug §10.18. This is the venue where
  // func bodies actually execute, so the real impls matter here.
  const scope = buildAdapterScope((def) => collected.push(def));
  const names = Object.keys(scope);
  const values = names.map((n) => scope[n]);
  const body = stripModuleSyntax(src);
  const make =
    evalFn ??
    ((ns: string[], b: string) =>
      new Function(...ns, `"use strict";\n${b}`) as (...v: unknown[]) => void);
  const fn = make(names, body);
  fn(...values);
  return collected;
}

export interface RunResult {
  status: 'ok' | 'navigating' | 'error';
  result?: unknown;
  navigateUrl?: string;
  error?: string;
}

/** Serialized fetch response handed back by the SW fetch proxy (F-5). */
interface SwFetchResp {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A minimal Response-like over the SW fetch-proxy result — covers the
 * `r.ok / r.status / r.headers.get / r.json() / r.text()` adapters actually use. */
function makeResponseLike(raw: SwFetchResp): unknown {
  const headers = raw?.headers ?? {};
  return {
    ok: raw?.ok ?? false,
    status: raw?.status ?? 0,
    statusText: raw?.statusText ?? '',
    url: raw?.url ?? '',
    headers: { get: (k: string) => headers[String(k).toLowerCase()] ?? null },
    async text() {
      return raw?.body ?? '';
    },
    async json() {
      return JSON.parse(raw?.body ?? 'null');
    },
  };
}

/** Normalize fetch `headers` (Headers instance | [k,v][] | object) to a plain
 * object so it survives the structured-clone hop to the SW. */
function normalizeFetchHeaders(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    const o: Record<string, string> = {};
    h.forEach((v, k) => {
      o[k] = v;
    });
    return o;
  }
  if (Array.isArray(h)) {
    const o: Record<string, string> = {};
    for (const pair of h) {
      if (Array.isArray(pair) && pair.length === 2) o[String(pair[0])] = String(pair[1]);
    }
    return o;
  }
  if (typeof h === 'object') return h as Record<string, string>;
  return undefined;
}

/**
 * Reduce a fetch `init` to the structured-clone-safe options before it crosses
 * the runner→SW port. The killer is `signal: AbortController.signal` — an
 * AbortSignal is NOT cloneable, so `port.postMessage` throws DataCloneError and
 * the whole fetch surfaces as "request failed" (weread-official/notebooklm pass a
 * signal for a client-side timeout). We drop `signal` (the runner's overall
 * timeout still bounds the call), normalize headers, and keep only the plain,
 * cloneable options. A ReadableStream body (rare here) is also dropped. See
 * adapter-hot-plug.md §10.35. Exported for unit tests. */
export function sanitizeFetchInit(init: unknown): Record<string, unknown> | undefined {
  if (!init || typeof init !== 'object') return undefined;
  const src = init as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof src.method === 'string') out.method = src.method;
  const headers = normalizeFetchHeaders(src.headers);
  if (headers) out.headers = headers;
  const isStream = typeof ReadableStream !== 'undefined' && src.body instanceof ReadableStream;
  if (src.body !== undefined && src.body !== null && !isStream) out.body = src.body;
  // Other standard, cloneable string/boolean options (signal deliberately omitted).
  for (const k of [
    'credentials',
    'mode',
    'cache',
    'redirect',
    'referrer',
    'referrerPolicy',
    'integrity',
    'keepalive',
  ]) {
    const v = src[k];
    if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** globalThis.fetch shim for browser:false funcs: route the request to the SW
 * via the page.fetch RPC (CORS-free, host_permissions <all_urls>) and wrap the
 * result as a Response-like — so a func's raw `fetch(...)` isn't bound by the
 * host page's CORS. See docs/tests findings F-5. `init` is sanitized first so a
 * non-cloneable AbortSignal can't break the port hop (§10.35). */
function swFetchVia(
  page: Record<string, unknown>,
): (input: unknown, init?: unknown) => Promise<unknown> {
  return async (input: unknown, init?: unknown) => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const pageFetch = page.fetch as ((u: string, o?: unknown) => Promise<SwFetchResp>) | undefined;
    if (typeof pageFetch !== 'function') {
      throw new TypeError('fetch proxy unavailable (page.fetch missing)');
    }
    return makeResponseLike(await pageFetch(url, sanitizeFetchInit(init)));
  };
}

/** Minimal browser `process` polyfill (F-19). opencli adapters are ported from
 * Node and occasionally reference `process` — stray debug writes
 * (`process.stderr.write`, youtube watch-later/playlist) or env reads
 * (`process.env.X`, weread-official/notebooklm/v2ex). The userScripts world has
 * no `process` → ReferenceError. A no-op stderr/stdout + empty env makes debug
 * writes vanish and env reads return undefined, so the adapter fails gracefully
 * (e.g. "no API key") instead of crashing. No adapter feature-detects
 * `typeof process`, so this is safe. */
export function browserProcessPolyfill(env: Record<string, string> = {}): Record<string, unknown> {
  const noop = (): void => {};
  return {
    // Copy so a later run's reset can't mutate a previous run's captured ref.
    env: { ...env },
    platform: 'browser',
    version: '',
    versions: {},
    argv: [],
    stderr: { write: noop },
    stdout: { write: noop },
    cwd: () => '/',
    nextTick: (fn: () => void) => queueMicrotask(fn),
  };
}

/** Make `process.env` carry exactly `env` for THIS adapter run.
 *
 * Two cases:
 *   - No `process` yet → install the full browser polyfill with `env`.
 *   - A `process` already exists. The USER_SCRIPT world is reused across adapter
 *     runs in the same tab, so a prior run's polyfilled `process` (with a prior
 *     secret in `env`) is still here — RESET its env to this run's set so secrets
 *     never leak adapter-to-adapter. But only when we own it (`platform ===
 *     'browser'`): a real Node `process` under tests must keep its real env. */
export function installProcessPolyfill(
  g: { process?: unknown },
  env: Record<string, string> = {},
): void {
  const proc = g.process as { platform?: unknown; env?: Record<string, unknown> } | undefined;
  if (!proc) {
    g.process = browserProcessPolyfill(env);
    return;
  }
  if (proc.platform === 'browser') proc.env = { ...env };
}

/**
 * Eval `source`, find the (site,name) command, and run its func with `page`.
 * Maps the navigate trampoline to status:'navigating' so the caller can let the
 * SW re-inject instead of treating it as an error.
 */
export async function runAdapterInPage(args: {
  source: string;
  site: string;
  name: string;
  kwargs: Record<string, unknown>;
  page: Record<string, unknown>;
  /** Secret env vars for this run (process.env.*); see InitMsg.env. */
  env?: Record<string, string>;
}): Promise<RunResult> {
  let defs: Record<string, unknown>[];
  try {
    defs = evalAdapterKeepingFuncs(args.source);
  } catch (e) {
    return { status: 'error', error: `eval failed: ${fmtError(e)}` };
  }
  const def = defs.find((d) => d.site === args.site && d.name === args.name);
  if (!def)
    return { status: 'error', error: `command ${args.site}/${args.name} not found in source` };
  const func = def.func;
  if (typeof func !== 'function') {
    return { status: 'error', error: `${args.site}/${args.name} has no func` };
  }
  // `browser: false` adapters (arxiv/wikipedia/hackernews read/…) declare
  // `func(kwargs)` — pure HTTP/transform, no page. The default is `func(page,
  // kwargs)`. Calling a single-arg func with (page, kwargs) hands it the PAGE as
  // its args, so it reads `args.<field>` off the page object and sees undefined
  // (e.g. "query cannot be empty" despite a query) — see docs/tests findings F-4.
  // Honor the flag so kwargs reach these funcs.
  // F-19: ensure a browser `process` exists before any func runs (stray
  // process.stderr.write / process.env reads would otherwise throw "process is
  // not defined"). Applies to every func, not just browser:false.
  installProcessPolyfill(globalThis as { process?: unknown }, args.env ?? {});
  const browserless = (def as { browser?: unknown }).browser === false;
  // F-5: browser:false funcs do raw HTTP via the global `fetch`, but in the host
  // page that's CORS-bound (export.arxiv.org, wiki search, … fail). Proxy `fetch`
  // through the SW (CORS-free) for the duration of the func, then restore.
  const g = globalThis as { fetch?: unknown };
  const origFetch = g.fetch;
  if (browserless) g.fetch = swFetchVia(args.page);
  try {
    const invoke = func as (...a: unknown[]) => Promise<unknown>;
    const result = browserless
      ? await invoke(args.kwargs)
      : await invoke(args.page, args.kwargs);
    return { status: 'ok', result };
  } catch (e) {
    // Deep-scan: an adapter that wraps page.goto in try/catch and re-throws
    // (zhihu/answer-detail, …) still leaves a recoverable marker via .cause
    // or the embedded message form — see findNavigateRestart.
    const nr = findNavigateRestart(e);
    if (nr) return { status: 'navigating', navigateUrl: nr.url };
    return { status: 'error', error: fmtError(e) };
  } finally {
    if (browserless) g.fetch = origFetch;
  }
}
