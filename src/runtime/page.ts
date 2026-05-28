/**
 * PageShim — implements the subset of opencli's `page` interface that
 * adapters use, via chrome.debugger (Runtime.evaluate), chrome.tabs,
 * chrome.scripting, and chrome.cookies.
 *
 * One shim per task, bound to a tab. The first call that needs CDP attaches
 * chrome.debugger; detach() releases it. The yellow "is being debugged"
 * banner appears while attached — acceptable cost for power-user automation.
 */

import { log, warn, error as logError } from './log';
import { RateLimitedError } from './errors.js';

type DebugTarget = chrome.debugger.Debuggee;

/**
 * Random delay to mimic human pacing. Used before navigations and between
 * scrolls so sustained operation against a single site doesn't trigger
 * rate-limit / captcha defenses.
 */
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * URLs that signal we've been rate-limited / captcha-gated and should
 * stop immediately. xhs redirects automation-flagged requests to
 * `/website-login/captcha?...&verifyType=...&verifyMsg=null` and the
 * page shows "Requests too frequent. Try again later.". Continuing to
 * hammer past this point escalates toward an account ban.
 */
const CAPTCHA_URL_PATTERNS: { domain: string; regex: RegExp }[] = [
  { domain: 'xiaohongshu.com', regex: /xiaohongshu\.com\/website-login(\/|\?|$)/i },
];

function captchaDomainFor(url: string): string | null {
  for (const { domain, regex } of CAPTCHA_URL_PATTERNS) {
    if (regex.test(url)) return domain;
  }
  return null;
}

/**
 * Auto-IIFE-wrap a JS string before sending to Runtime.evaluate. opencli's
 * page.evaluate does this internally so adapter code can write either an
 * IIFE OR a bare arrow function — both work. We mirror the behavior here
 * so byte-imported adapters from opencli (which sometimes write
 * `async () => {...}` un-invoked) don't silently return the function
 * object instead of its awaited result.
 *
 * Source: opencli/src/browser/utils.ts wrapForEval()
 */
function wrapForEval(js: string): string {
  if (typeof js !== 'string') return 'undefined';
  const code = js.trim();
  if (!code) return 'undefined';
  // Already an IIFE: `(...)( ... )`
  if (/^\([\s\S]*\)\s*\(.*\)\s*$/.test(code)) return code;
  // Arrow function: `() => ...` or `async () => ...`
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_]\w*)\s*=>/.test(code)) return `(${code})()`;
  // Function declaration: `function ...` or `async function ...`
  if (/^(async\s+)?function[\s(]/.test(code)) return `(${code})()`;
  // Bare expression — `new Promise(...)`, an object literal, etc. — leave as-is.
  return code;
}

export interface PageShim {
  readonly tabId: number;
  goto(url: string): Promise<void>;
  evaluate<T = unknown>(jsString: string): Promise<T>;
  /**
   * Sleep for `time` seconds. Accepts either `{ time }` (canonical) or a
   * bare number for upstream-opencli byte-compat — some adapters call
   * `page.wait(1)` expecting "1 second" and the destructuring form would
   * silently no-op (`{time}` from a number → undefined → setTimeout(NaN)).
   */
  wait(opts: { time: number } | number): Promise<void>;
  autoScroll(opts: { times: number; delayMs?: number }): Promise<void>;
  getCookies(): Promise<chrome.cookies.Cookie[]>;
  screenshot(): Promise<string>;
  /**
   * Arm a network capture for the next XHR/Fetch response whose URL matches
   * `urlPattern`. Returns a `{body}` object once the listener is fully
   * armed (debugger attached, Network domain enabled, listener registered).
   *
   * Usage (two-phase, IMPORTANT for race-free capture):
   *
   *   const cap = await page.captureNetwork('homefeed');  // arm BEFORE action
   *   await page.goto('https://...');                     // trigger the request
   *   const data = await cap.body;                        // wait for body
   *
   * If you skip the first await and pass the un-armed promise to .body, the
   * request often fires before the listener registers and you'll timeout.
   * On timeout, the error message includes the URLs of all XHR/Fetch
   * responses seen during the window so you can spot a wrong pattern.
   */
  captureNetwork<T = unknown>(
    urlPattern: string | RegExp,
    opts?: { timeoutMs?: number },
  ): Promise<{ body: Promise<T> }>;
  /**
   * Download a remote URL to the user's Downloads folder via
   * chrome.downloads. The browser uses its own cookie store for the
   * request, so authenticated CDN assets work without extra plumbing.
   * `filename` is a relative subpath under Downloads/.
   *
   * Resolves when the download enters a terminal state ('complete' or
   * 'interrupted'). Caller decides whether to throw on !ok.
   */
  downloadFile(opts: {
    url: string;
    filename: string;
    conflictAction?: chrome.downloads.FilenameConflictAction;
  }): Promise<{ id: number; bytes: number; ok: boolean; error?: string; filename: string }>;
  /**
   * Return user-attached File objects (images for publish, etc.). The
   * files are supplied by the side-panel UI out-of-band from LLM tool
   * args — the agent loop reads them from the user state and hands them
   * to the PageShim at construction time.
   */
  getAttachments(): File[];
  /**
   * Type text into whatever element currently has focus, via CDP Input.
   *
   * - mode 'char' (default): per-character keyDown → char → keyUp via
   *   Input.dispatchKeyEvent. Slow but observed by every framework
   *   including aggressive Vue v-model custom directives.
   * - mode 'batch': single Input.insertText (IME-commit style). Faster
   *   but some frameworks treat it as not "real" input and ignore.
   *
   * For controlled inputs (xhs publish title, etc.), prefer 'char'.
   */
  insertText(text: string, opts?: { mode?: 'batch' | 'char' }): Promise<void>;
  /**
   * Monkey-patch fetch + XMLHttpRequest in the page so that responses
   * whose URL contains `pattern` get parsed as JSON and pushed onto a
   * hidden global array. Call this AFTER `goto` (since navigation wipes
   * the patches), then trigger the request, then call
   * `getInterceptedRequests()`. Used by adapters as a fallback when
   * direct `fetch` from page.evaluate returns the wrong shape.
   *
   * Idempotent: re-calling with the same pattern only updates the
   * pattern; the patches are installed once per page lifetime.
   */
  installInterceptor(pattern: string): Promise<void>;
  /**
   * Read (and clear) the buffer of intercepted JSON responses captured
   * since the last call (or since installInterceptor was first invoked).
   */
  getInterceptedRequests(): Promise<unknown[]>;
  detach(): Promise<void>;
}

export async function createPageShim(
  tabId: number,
  opts: { attachments?: File[] } = {},
): Promise<PageShim> {
  const target: DebugTarget = { tabId };
  let attached = false;
  const attachments = opts.attachments ?? [];

  async function ensureAttached() {
    if (attached) return;
    log('page', `debugger.attach tabId=${tabId}`);
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  }

  async function waitForTabComplete(timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(`goto timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // Closure-scoped evaluate helper. The public `evaluate` method just
  // delegates here, and internal helpers (installInterceptor /
  // getInterceptedRequests) call it directly without going through
  // `this` (which doesn't type-resolve cleanly in object literals).
  async function evalJs<T>(jsString: string): Promise<T> {
    await ensureAttached();
    const t0 = Date.now();
    const expression = wrapForEval(jsString);
    const result = (await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result?: { value: T; type: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const elapsed = Date.now() - t0;
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluate failed';
      logError('page', `evaluate threw (${elapsed}ms)`, {
        scriptPreview: jsString.slice(0, 200),
        exception: msg,
      });
      throw new Error(`page.evaluate threw: ${msg}`);
    }
    const valueType = typeof result.result?.value;
    let valuePreview: string;
    try {
      valuePreview = JSON.stringify(result.result?.value).slice(0, 240);
    } catch {
      valuePreview = '[unserializable]';
    }
    log('page', `evaluate ok (${elapsed}ms)`, {
      scriptLen: jsString.length,
      wrapped: expression.length !== jsString.trim().length,
      returnType: result.result?.type ?? valueType,
      valuePreview,
    });
    return result.result?.value as T;
  }

  return {
    tabId,

    async goto(url) {
      // Human-like decision delay BEFORE issuing the navigation.
      await humanDelay(800, 1800);

      log('page', `goto ${url}`);
      const t0 = Date.now();
      const completePromise = waitForTabComplete();
      await chrome.tabs.update(tabId, { url });
      await completePromise;
      log('page', `goto complete (${Date.now() - t0}ms)`);

      // Did the site redirect us to a captcha / verification flow?
      // If so, STOP immediately — adapter code shouldn't keep poking.
      const tab = await chrome.tabs.get(tabId);
      const landedAt = tab.url ?? '';
      const captchaDomain = captchaDomainFor(landedAt);
      if (captchaDomain) {
        logError('page', `rate-limited / captcha redirect detected`, { landedAt });
        throw new RateLimitedError(
          captchaDomain,
          landedAt,
          `${captchaDomain} redirected to a captcha/verification page (${landedAt}). Stop and try again later.`,
        );
      }

      // Settling time after navigation — human reading the page before scrolling.
      await humanDelay(1200, 2400);
    },

    async evaluate<T>(jsString: string): Promise<T> {
      return evalJs<T>(jsString);
    },

    async wait(opts) {
      const time = typeof opts === 'number' ? opts : opts?.time;
      const secs = typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0;
      log('page', `wait ${secs}s`);
      await new Promise((r) => setTimeout(r, secs * 1000));
    },

    async autoScroll({ times, delayMs }) {
      // Randomize the inter-scroll delay if not explicitly provided —
      // a uniform 600ms cadence reads as obviously-scripted scroll.
      log('page', `autoScroll times=${times} delayMs=${delayMs ?? 'jittered'}`);
      for (let i = 0; i < times; i++) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () =>
            window.scrollBy(0, Math.floor(window.innerHeight * (0.7 + Math.random() * 0.2))),
        });
        const wait = delayMs ?? 800 + Math.floor(Math.random() * 700);
        await new Promise((r) => setTimeout(r, wait));
      }
    },

    async getCookies() {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url) return [];
      const cookies = await chrome.cookies.getAll({ url: tab.url });
      log('page', `getCookies url=${tab.url} count=${cookies.length}`);
      return cookies;
    },

    async screenshot() {
      await ensureAttached();
      log('page', 'screenshot');
      const result = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
      })) as { data: string };
      return result.data;
    },

    async captureNetwork<T>(
      urlPattern: string | RegExp,
      opts: { timeoutMs?: number } = {},
    ): Promise<{ body: Promise<T> }> {
      // PHASE 1 (armed): attach debugger, enable Network domain, register
      // listener. All synchronous-looking awaits are completed BEFORE this
      // method returns, so the caller can safely fire the request-
      // triggering action after `await captureNetwork(...)`.
      await ensureAttached();
      await chrome.debugger.sendCommand(target, 'Network.enable', {});
      const matcher = urlPattern instanceof RegExp ? urlPattern : new RegExp(urlPattern);
      const timeoutMs = opts.timeoutMs ?? 15_000;
      log('page', `captureNetwork armed pattern=${matcher.source} timeout=${timeoutMs}ms`);

      // Collect URLs we see for diagnostic output on timeout (XHR/Fetch only,
      // to skip noise from CSS/images/fonts/etc.).
      const seenUrls: string[] = [];

      const body = new Promise<T>((resolve, reject) => {
        let matchedRequestId: string | null = null;
        let matchedUrl = '';

        const cleanup = () => {
          chrome.debugger.onEvent.removeListener(handler);
          clearTimeout(timer);
        };

        const timer = setTimeout(() => {
          cleanup();
          const tail = seenUrls.slice(-25);
          const more = seenUrls.length > tail.length ? ` (showing last ${tail.length})` : '';
          const seenList = tail.length
            ? `\nSaw ${seenUrls.length} XHR/Fetch responses${more}:\n  - ${tail.join('\n  - ')}`
            : '\nNo XHR/Fetch responses observed during the window.';
          reject(
            new Error(
              `captureNetwork timeout: no match for /${matcher.source}/ within ${timeoutMs}ms.${seenList}`,
            ),
          );
        }, timeoutMs);

        const handler = async (source: DebugTarget, method: string, params: unknown) => {
          if (source.tabId !== tabId) return;
          try {
            if (method === 'Network.responseReceived') {
              const p = params as {
                requestId: string;
                type: string;
                response: { url: string };
              };
              // Filter to XHR/Fetch — ignore Document/Script/Stylesheet/Image/etc.
              if (p.type !== 'XHR' && p.type !== 'Fetch') return;
              seenUrls.push(p.response.url);
              log('page', `captureNetwork saw ${p.type}`, { url: p.response.url });
              if (matchedRequestId === null && matcher.test(p.response.url)) {
                matchedRequestId = p.requestId;
                matchedUrl = p.response.url;
                log('page', `captureNetwork matched`, {
                  url: matchedUrl,
                  requestId: matchedRequestId,
                });
              }
            } else if (method === 'Network.loadingFinished') {
              const p = params as { requestId: string };
              if (p.requestId !== matchedRequestId) return;
              const rawBody = (await chrome.debugger.sendCommand(
                target,
                'Network.getResponseBody',
                { requestId: matchedRequestId },
              )) as { body: string; base64Encoded: boolean };
              const text = rawBody.base64Encoded ? atob(rawBody.body) : rawBody.body;
              cleanup();
              log('page', `captureNetwork body received`, { url: matchedUrl, bytes: text.length });
              resolve(JSON.parse(text) as T);
            }
          } catch (e) {
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        };

        chrome.debugger.onEvent.addListener(handler);
      });

      return { body };
    },

    async downloadFile({ url, filename, conflictAction = 'uniquify' }) {
      log('page', `downloadFile`, { url, filename });
      const id = await chrome.downloads.download({ url, filename, conflictAction });
      return new Promise((resolve) => {
        const onChange = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== id) return;
          const state = delta.state?.current;
          if (state !== 'complete' && state !== 'interrupted') return;
          chrome.downloads.onChanged.removeListener(onChange);
          chrome.downloads
            .search({ id })
            .then(([item]) => {
              const ok = state === 'complete';
              const error = ok ? undefined : (delta.error?.current ?? 'interrupted');
              log('page', `downloadFile ${ok ? '✓' : '✗'}`, {
                id,
                bytes: item?.bytesReceived ?? 0,
                error,
              });
              resolve({
                id,
                bytes: item?.bytesReceived ?? 0,
                ok,
                error,
                filename: item?.filename ?? filename,
              });
            })
            .catch(() => {
              resolve({ id, bytes: 0, ok: false, error: 'lookup failed', filename });
            });
        };
        chrome.downloads.onChanged.addListener(onChange);
      });
    },

    getAttachments() {
      return attachments.slice();
    },

    async insertText(text: string, opts: { mode?: 'batch' | 'char' } = {}) {
      await ensureAttached();
      const mode = opts.mode ?? 'char';
      if (mode === 'batch') {
        // Single-batch IME-style. Faster but some frameworks ignore it.
        log('page', `insertText batch (${text.length} chars)`);
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
        return;
      }
      // Full keystroke sequence: keyDown → char → keyUp per character.
      // Some Vue v-model setups only respect the full keyboard pair
      // (keyDown/keyUp listeners); a lone 'char' or batch insertText is
      // silently dropped. This path is slower (~20-50ms per char) but
      // reliable across frameworks.
      //
      // IMPORTANT: keyDown/keyUp must NOT carry `text`. A `keyDown` with a
      // `text` field already inserts the character on its own — combined
      // with the `char` event (which also inserts) that doubles every
      // character ("说" → "说说"). Only the `char` event carries `text`.
      log('page', `insertText char (${text.length} chars)`);
      for (const char of text) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: char,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'char',
          text: char,
          unmodifiedText: char,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: char,
        });
      }
    },

    async installInterceptor(pattern: string) {
      log('page', `installInterceptor pattern=${pattern}`);
      // Mirrors opencli's generateInterceptorJs — monkey-patch fetch + XHR
      // in the page context so JSON responses whose URL contains `pattern`
      // are pushed onto a hidden global array. patternVar is mutable so
      // re-calling updates the pattern without re-patching.
      const js = `
        (() => {
          const ARR = '__xhs_op_xhr';
          const GUARD = '__xhs_op_xhr_patched';
          const PAT = '__xhs_op_xhr_pattern';
          if (!window[ARR]) {
            Object.defineProperty(window, ARR, { value: [], writable: true, enumerable: false, configurable: true });
          }
          Object.defineProperty(window, PAT, { value: ${JSON.stringify(pattern)}, writable: true, enumerable: false, configurable: true });
          if (window[GUARD]) return true;
          Object.defineProperty(window, GUARD, { value: true, writable: false, enumerable: false, configurable: false });

          const check = (url) => {
            const p = window[PAT];
            return typeof url === 'string' && p && url.includes(p);
          };

          const origFetch = window.fetch;
          window.fetch = async function(...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            const response = await origFetch.apply(this, args);
            if (check(url)) {
              try {
                const clone = response.clone();
                const json = await clone.json();
                window[ARR].push(json);
              } catch (e) { /* non-JSON body — skip */ }
            }
            return response;
          };

          const XHR = XMLHttpRequest.prototype;
          const origOpen = XHR.open;
          const origSend = XHR.send;
          XHR.open = function(method, url) {
            Object.defineProperty(this, '__iurl', { value: String(url), writable: true, enumerable: false, configurable: true });
            return origOpen.apply(this, arguments);
          };
          XHR.send = function() {
            if (check(this.__iurl)) {
              this.addEventListener('load', function() {
                try {
                  window[ARR].push(JSON.parse(this.responseText));
                } catch (e) { /* non-JSON — skip */ }
              });
            }
            return origSend.apply(this, arguments);
          };
          return true;
        })()
      `;
      await evalJs(js);
    },

    async getInterceptedRequests() {
      const js = `
        (() => {
          const data = window.__xhs_op_xhr || [];
          window.__xhs_op_xhr = [];
          return data;
        })()
      `;
      const result = await evalJs<unknown[]>(js);
      log('page', `getInterceptedRequests`, { count: Array.isArray(result) ? result.length : 0 });
      return Array.isArray(result) ? result : [];
    },

    async detach() {
      if (!attached) return;
      log('page', 'debugger.detach');
      try {
        await chrome.debugger.detach(target);
      } catch (e) {
        warn('page', 'detach error (already detached?)', e);
      }
      attached = false;
    },
  };
}
