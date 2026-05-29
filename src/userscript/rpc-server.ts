/**
 * page.* RPC server — the service-worker counterpart to makeLocalPage()
 * (src/userscript/run-in-page.ts).
 *
 * When an installed func adapter runs in a tab's USER_SCRIPT world, its
 * DOM-local calls (evaluate/wait/scroll) run in-page, but the chrome.* / CDP
 * ones (goto, getCookies, screenshot, cdp, native input, interceptors,
 * downloadFile) are RPC'd back to the SW, which holds the real PageShim (CDP
 * via chrome.debugger
 * + chrome.cookies/tabs), so it fulfills each RPC by calling the matching shim
 * method. This module is that dispatch table.
 *
 * Pure + testable: it takes a `PageLike` (the subset of PageShim it calls), so
 * tests pass a fake and assert the method/arg mapping without a browser.
 *
 * Wire shape (must match makeLocalPage):
 *   goto  → rpc('goto',  { url, tabId })          → page.goto(url)
 *   other → rpc(method, { args: [...], tabId })   → page[method](...args)
 */

import { log, warn } from '../runtime/log';

/** The PageShim subset the RPC server may invoke. All optional so a fake (and
 * a partial real shim) satisfy it; an unsupported method yields a clear error
 * rather than a crash. */
export interface PageLike {
  goto?(url: string): Promise<void>;
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
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}
