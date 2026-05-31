/**
 * Test helper for marketplace-bundled wikipedia adapters.
 *
 * Unlike bilibili/reddit (which route through `page.evaluate`), wikipedia's
 * bundled adapters never touch a `page` at all: their `func` is
 * `async (args) => {...}` and every network call goes through an INLINED
 * `wikiFetch(lang, path)` that calls the global `fetch()` directly and then
 * `resp.json()`.
 *
 * opencli's tests mock the `wikiFetch` export from `./utils.js`. That module
 * boundary doesn't exist in our bundle (esbuild inlined `wikiFetch` as a
 * local), so the mock seam moves down one level to `globalThis.fetch`.
 *
 * Mapping vs. opencli test conventions:
 *   opencli                                      → here
 *   ─────────────────────────────────────────────────────────────────────
 *   getRegistry().get('wikipedia/x')             → findAdapter('wikipedia', 'x')
 *   import {..} from '@jackwener/opencli/errors'  → '../../../src/runtime/errors.js'
 *   wikiFetchMock.mockResolvedValueOnce(payload) → fetchMock.mockResolvedValueOnce(jsonResponse(payload))
 *   command.func({ limit, lang })                → command.func({ limit, lang })  (no page arg)
 *
 * `installWikiFetch()` stubs `globalThis.fetch` with a vi.fn() and returns it
 * plus a restore fn; pair it with `jsonResponse(payload)` to feed the inlined
 * `wikiFetch` exactly the `{ ok, status, json() }` shape it consumes.
 */

import { vi, type Mock } from 'vitest';

export type FetchMock = Mock<(url: string, opts?: unknown) => Promise<unknown>>;

/** Minimal Response-like object that the inlined `wikiFetch` consumes:
 * it reads `.ok`, `.status`, and calls `.json()`. */
export function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  };
}

export interface WikiFetchHarness {
  fetchMock: FetchMock;
  restore: () => void;
}

/** Replace `globalThis.fetch` with a vi.fn(). Returns the mock (so tests can
 * arm `.mockResolvedValueOnce(jsonResponse(...))` and assert on call args) and
 * a `restore()` that puts the original `fetch` back. */
export function installWikiFetch(): WikiFetchHarness {
  const original = globalThis.fetch;
  const fetchMock: FetchMock = vi.fn();
  // @ts-expect-error -- test fetch mock has a looser signature than DOM fetch
  globalThis.fetch = fetchMock;
  return {
    fetchMock,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
