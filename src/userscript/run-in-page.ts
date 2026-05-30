/**
 * In-page adapter runtime — the Phase B (func-type hot-plug) execution core.
 *
 * This code runs INSIDE a target tab's USER_SCRIPT world (injected via
 * chrome.userScripts), where:
 *   - the page's DOM is directly available, so page.evaluate/wait/scroll run
 *     LOCALLY (no RPC) — the win over the CDP model for the evaluate-heavy
 *     opencli corpus (~874 evaluate calls vs a long RPC tail);
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

/** Thrown by page.goto when a navigation is needed. The top-level runner maps
 * this to a "navigating, will resume after reinject" outcome rather than an
 * error. Tagged property (not an Error subclass) so detection works across the
 * eval boundary where `instanceof` is unreliable. */
export const NAVIGATE_RESTART = '__webchat_navigate_restart__';
export interface NavigateRestart {
  [NAVIGATE_RESTART]: true;
  url: string;
}
export function isNavigateRestart(v: unknown): v is NavigateRestart {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[NAVIGATE_RESTART] === true;
}

/** page.* methods that must be RPC'd to the SW (need chrome.* / CDP). Everything
 * else runs locally in the page. Kept as data so it's greppable + testable. */
export const RPC_METHODS = new Set([
  'goto', // special-cased (trampoline) but still RPCs the navigate
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

    async evaluate(js: string): Promise<unknown> {
      return doEval(wrapForEval(js));
    },

    async wait(arg: { time?: number; selector?: string; text?: string; timeout?: number } | number) {
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

    getCurrentUrl(): string {
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
      await rpc('goto', { url, tabId });
      // Stop the func; the SW will re-inject after the tab loads.
      throw { [NAVIGATE_RESTART]: true, url } as NavigateRestart;
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
  const Strategy = Object.freeze({
    PUBLIC: 'public',
    LOCAL: 'local',
    COOKIE: 'cookie',
    INTERCEPT: 'intercept',
    UI: 'ui',
    DIRECT: 'direct',
    AUTO: 'auto',
  });
  const cli = (def: Record<string, unknown>) => {
    if (!def || typeof def !== 'object') throw new Error('cli() expects an object');
    if (!def.site || !def.name) throw new Error('cli() definition missing site/name');
    collected.push(def);
    return def;
  };
  class CliError extends Error {}
  const mkErr = (name: string) =>
    class extends CliError {
      constructor(...a: unknown[]) {
        super(typeof a[0] === 'string' ? a[0] : name);
        this.name = name;
      }
    };
  const scope: Record<string, unknown> = {
    cli,
    Strategy,
    registerCommand: cli,
    fullName: (c: { site: string; name: string }) => `${c.site}/${c.name}`,
    onStartup: () => {},
    onBeforeExecute: () => {},
    onAfterExecute: () => {},
    CliError,
    ArgumentError: mkErr('ArgumentError'),
    AuthRequiredError: mkErr('AuthRequiredError'),
    EmptyResultError: mkErr('EmptyResultError'),
    RateLimitedError: mkErr('RateLimitedError'),
    CommandExecutionError: mkErr('CommandExecutionError'),
    ConfigError: mkErr('ConfigError'),
    TimeoutError: mkErr('TimeoutError'),
    LoginWallError: mkErr('LoginWallError'),
    NeedsAttachmentsError: mkErr('NeedsAttachmentsError'),
    selectorError: (s: string) => new CliError(`selector: ${s}`),
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    isRecord: (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v),
    htmlToMarkdown: (v: unknown) => v,
    throwIfLoginWall: (v: unknown) => v,
    parseJsonOrThrowLoginWall: (v: unknown) => v,
    sleep: () => Promise.resolve(),
    mapConcurrent: async () => [],
    BROWSER_JSON_SNIFF_FN: '',
    EXIT_CODES: {},
  };
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
}): Promise<RunResult> {
  let defs: Record<string, unknown>[];
  try {
    defs = evalAdapterKeepingFuncs(args.source);
  } catch (e) {
    return { status: 'error', error: `eval failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const def = defs.find((d) => d.site === args.site && d.name === args.name);
  if (!def) return { status: 'error', error: `command ${args.site}/${args.name} not found in source` };
  const func = def.func;
  if (typeof func !== 'function') {
    return { status: 'error', error: `${args.site}/${args.name} has no func` };
  }
  try {
    const result = await (func as (p: unknown, k: unknown) => Promise<unknown>)(args.page, args.kwargs);
    return { status: 'ok', result };
  } catch (e) {
    if (isNavigateRestart(e)) return { status: 'navigating', navigateUrl: e.url };
    return { status: 'error', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
