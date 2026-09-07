/**
 * page.* RPC server — the service-worker counterpart to makeLocalPage()
 * (src/userscript/run-in-page.ts).
 *
 * When an installed func adapter runs in a tab's USER_SCRIPT world, the
 * DOM-only helpers (wait/scroll) run in-page, but everything that needs
 * chrome.* / CDP / MAIN-world is RPC'd back to the SW. Notably this includes
 * `evaluate`: adapter JS reads page bootstrap globals like
 * `window.ytInitialData`, which live in MAIN world and are invisible from the
 * isolated USER_SCRIPT globalThis (see run-in-page.ts header). The SW holds
 * the real PageShim (CDP via chrome.debugger + chrome.cookies/tabs), so it
 * fulfills each RPC by calling the matching shim method. This module is that
 * dispatch table.
 *
 * Pure + testable: it takes a `PageLike` (the subset of PageShim it calls), so
 * tests pass a fake and assert the method/arg mapping without a browser.
 *
 * Wire shape (must match makeLocalPage):
 *   goto  → rpc('goto',  { url, tabId })          → page.goto(url)
 *   other → rpc(method, { args: [...], tabId })   → page[method](...args)
 */

import { log, warn } from '@base/runtime/log';
import { fmtError } from './run-in-page';

/** The PageShim subset the RPC server may invoke. All optional so a fake (and
 * a partial real shim) satisfy it; an unsupported method yields a clear error
 * rather than a crash. */
export interface PageLike {
  goto?(url: string): Promise<void>;
  evaluate?(jsString: string): Promise<unknown>;
  getCookies?(): Promise<unknown>;
  screenshot?(): Promise<unknown>;
  cdp?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  installInterceptor?(pattern: string): Promise<void>;
  getInterceptedRequests?(): Promise<unknown[]>;
  downloadFile?(opts: unknown): Promise<unknown>;
  nativeType?(text: string): Promise<void>;
  nativeClick?(x: number, y: number): Promise<void>;
  nativeKeyPress?(key: string, modifiers?: string[]): Promise<void>;
  setFileInput?(files: string[], selector?: string): Promise<void>;
}

export interface RpcRequest {
  method: string;
  /** For goto: the target URL. */
  url?: string;
  /** For everything else: the positional args array from makeLocalPage. */
  args?: unknown[];
  tabId?: number;
}

export interface RpcResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Methods the server will fulfill. Mirrors RPC_METHODS in run-in-page.ts (the
 * caller side); kept as its own list so a mismatch is caught by the test that
 * asserts the two agree. */
export const SERVER_METHODS = new Set([
  'goto',
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
  // Not a page/CDP method — the func's global fetch proxied here so browser:false
  // adapters get CORS-free HTTP from the SW (host_permissions <all_urls>). F-5.
  'fetch',
  // page.tabs() — enumerate browser tabs via chrome.tabs.query (SW). F-21.
  'tabs',
]);

/**
 * Fulfill one page.* RPC against a PageShim. Never throws — failures come back
 * as `{ ok:false, error }` so the in-page caller gets a value, not a dropped
 * promise.
 */
export async function fulfillRpc(page: PageLike, req: RpcRequest): Promise<RpcResponse> {
  const { method } = req;
  if (!SERVER_METHODS.has(method)) {
    return { ok: false, error: `unsupported page RPC method: ${method}` };
  }
  // `fetch` is NOT a page/CDP method — it's the func's global fetch proxied to a
  // direct SW fetch (CORS-free via <all_urls>), so browser:false adapters do raw
  // HTTP like opencli's node fetch instead of being bound by the host page's
  // CORS. See docs/tests findings F-5.
  if (method === 'fetch') {
    return fulfillFetch(req.args);
  }
  // `tabs` — enumerate browser tabs (chrome.tabs.query), so an adapter can find a
  // result opened in a new tab (gemini deep-research-result). F-21.
  if (method === 'tabs') {
    return fulfillTabs();
  }
  const fn = (page as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    return { ok: false, error: `PageShim does not implement ${method} in this context` };
  }
  const args = Array.isArray(req.args) ? req.args : [];
  try {
    log('userscript-rpc', `page.${method}`, { tabId: req.tabId });
    let value: unknown;
    if (method === 'goto') {
      value = await (fn as (u: string) => Promise<unknown>).call(page, req.url ?? '');
    } else {
      value = await (fn as (...a: unknown[]) => Promise<unknown>).apply(page, args);
    }
    return { ok: true, value };
  } catch (e) {
    warn('userscript-rpc', `page.${method} threw`, e);
    return { ok: false, error: fmtError(e) };
  }
}

/** Direct SW fetch for a func's proxied global `fetch` (F-5). Serializes the
 * Response to a plain shape the in-page Response-like reconstructs. Never throws
 * — network errors come back as { ok:false }. */
async function fulfillFetch(rawArgs?: unknown[]): Promise<RpcResponse> {
  const args = Array.isArray(rawArgs) ? rawArgs : [];
  const url = String(args[0] ?? '');
  const options = args[1] && typeof args[1] === 'object' ? (args[1] as RequestInit) : undefined;
  try {
    const resp = await fetch(url, options);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = await resp.text();
    return {
      ok: true,
      value: {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText,
        url: resp.url,
        headers,
        body,
      },
    };
  } catch (e) {
    return { ok: false, error: fmtError(e) };
  }
}

/** Enumerate browser tabs for `page.tabs()` (F-21) — chrome.tabs.query in the SW,
 * trimmed to the fields adapters use (url/title/id/active). Never throws. */
async function fulfillTabs(): Promise<RpcResponse> {
  try {
    const g = globalThis as { chrome?: { tabs?: { query?: (q: object) => Promise<unknown[]> } } };
    if (!g.chrome?.tabs?.query) {
      return { ok: false, error: 'chrome.tabs unavailable' };
    }
    const tabs = (await g.chrome.tabs.query({})) as Array<{
      id?: number;
      url?: string;
      title?: string;
      active?: boolean;
    }>;
    return {
      ok: true,
      value: tabs.map((t) => ({
        id: t.id,
        url: t.url ?? '',
        title: t.title ?? '',
        active: !!t.active,
      })),
    };
  } catch (e) {
    return { ok: false, error: fmtError(e) };
  }
}
