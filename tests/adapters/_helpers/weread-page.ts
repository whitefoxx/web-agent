/**
 * Fake page for testing marketplace-bundled weread adapters.
 *
 * Unlike bilibili (whose adapters funnel API calls through a single
 * `page.evaluate(<fetch script>)` we must URL-route), the weread adapters do
 * their networking with the GLOBAL `fetch` directly — the same boundary the
 * opencli tests stub via `vi.stubGlobal('fetch', ...)`. So there is no URL
 * router to recover here; each test seeds `fetch` with canned `Response`-like
 * objects exactly as the opencli weread tests do.
 *
 * The only page-level seam the adapters touch is `page.getCookies(...)`, used
 * by `ai-outline` to build the Cookie header. The bundled adapter issues TWO
 * `getCookies` calls inside a `Promise.all`:
 *
 *     const [apiCookies, domainCookies] = await Promise.all([
 *       page.getCookies({ url }),           // call #1 → apiCookies
 *       page.getCookies({ domain }),        // call #2 → domainCookies
 *     ]);
 *
 * matching opencli's own source. opencli's ai-outline.test.js arms exactly two
 * sequential results (`wr_vid` then `wr_name`), so this helper just exposes
 * `getCookies` as a `vi.fn()` the test can drive with
 * `.mockResolvedValueOnce(...)` — identical surface to the opencli `page`.
 *
 * `book-search`'s bundled `func` takes ONLY `args` (no page) and uses global
 * `fetch`, so it needs no page at all.
 *
 * Mapping vs. opencli test conventions:
 *   getRegistry().get('weread/x')            → findAdapter('weread', 'x')
 *   '@jackwener/opencli/errors'              → '../../../src/runtime/errors.js'
 *   page = { getCookies: vi.fn() }           → makeFakeWereadPage()
 *   vi.stubGlobal('fetch', ...)              → vi.stubGlobal('fetch', ...)  (unchanged)
 */

import { vi, type Mock } from 'vitest';

export interface FakeWereadPage {
  getCookies: Mock<(opts?: unknown) => Promise<Array<{ name: string; value: string; domain?: string }>>>;
}

export function makeFakeWereadPage(): FakeWereadPage {
  return {
    getCookies: vi.fn().mockResolvedValue([]),
  };
}
