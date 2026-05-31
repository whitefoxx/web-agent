/**
 * Fake page(s) for testing marketplace-bundled reddit adapters.
 *
 * Unlike bilibili (where every API call is routed through a single
 * `page.evaluate(<fetch script>)` whose URL we parse), reddit's bundled
 * adapters call `page.goto(...)` then `page.evaluate(<self-contained async
 * IIFE>)` whose RETURN VALUE is a discriminated-union envelope
 * (`{ kind: 'ok' | 'auth' | 'http' | ... }`). The Node-side `func` only
 * inspects that envelope and re-throws typed errors.
 *
 * opencli's reddit tests therefore use TWO seams, both reproduced here:
 *
 *   1. makeFakeRedditPage() — the common case. `evaluate` is a plain
 *      vi.fn() whose resolved value is the canned envelope. Tests do
 *      `page.evaluate.mockResolvedValue({ kind: 'ok', entries: [...] })` (we
 *      pre-arm it via the constructor arg). This matches opencli's
 *      `makePage(result)` helper used by home / reply / whoami / subreddit-info
 *      / subscribed.
 *
 *   2. makeRuntimeRedditPage(fetchImpl) — the integration case (read's
 *      `makeRuntimePage`, subreddit-info's `new Function('fetch', ...)`).
 *      Here `evaluate` actually `eval`s the script string with a mocked
 *      `globalThis.fetch`, so the in-page logic (morechildren re-threading,
 *      404 → missing) runs for real. The script is a bare expression
 *      `(async () => {...})()`, so `eval()` returns its promise.
 *
 * Mapping vs. opencli test conventions:
 *   opencli                                   → here
 *   ──────────────────────────────────────────────────────────────────────
 *   getRegistry().get('reddit/x')             → findAdapter('reddit', 'x')
 *   import {.. } from '@jackwener/opencli/errors' → '../../../src/runtime/errors.js'
 *   makePage(result)                          → makeFakeRedditPage(result)
 *   makeRuntimePage(fetchImpl)                → makeRuntimeRedditPage(fetchImpl)
 *   command.func(page, kwargs)                → command.func(page, kwargs)
 */

import { vi, type Mock } from 'vitest';

export interface FakeRedditPage {
  goto: Mock<(url: string) => Promise<void>>;
  evaluate: Mock<(script: string) => Promise<unknown>>;
}

/**
 * Page whose `evaluate` resolves to a fixed, pre-canned envelope — mirrors
 * opencli's `makePage(result)`. The script is never executed; only its
 * presence (`page.evaluate.mock.calls[0][0]`) is asserted by some tests.
 */
export function makeFakeRedditPage(result?: unknown): FakeRedditPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(result),
  };
}

/**
 * Page whose `evaluate` REALLY runs the in-browser script with a mocked
 * `globalThis.fetch`. Mirrors opencli's `makeRuntimePage(fetchImpl)`. The
 * bundled adapter's script is a top-level expression `(async () => {...})()`,
 * so a plain `eval` returns the resulting promise.
 */
export function makeRuntimeRedditPage(
  fetchImpl: (url: string, opts?: unknown) => Promise<unknown>,
): FakeRedditPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script: string) => {
      const previousFetch = globalThis.fetch;
      // @ts-expect-error -- test fetch mock has a looser signature than DOM fetch
      globalThis.fetch = fetchImpl;
      try {
        // eslint-disable-next-line no-eval
        return await eval(script);
      } finally {
        globalThis.fetch = previousFetch;
      }
    }),
  };
}

/** jsonResponse(payload, status) — the fetch-mock response shape reddit's
 * in-page scripts expect (`.ok`, `.status`, `.json()`). */
export function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  };
}
