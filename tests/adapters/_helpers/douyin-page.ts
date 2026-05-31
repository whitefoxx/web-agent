/**
 * Fake page for testing marketplace-bundled douyin adapters.
 *
 * Opencli's douyin tests `vi.mock('./_shared/browser-fetch.js', ...)` (and for
 * user-videos, `vi.mock('./_shared/public-api.js', ...)`) to swap the shared
 * helpers. Our marketplace adapters have those helpers INLINED (no module
 * boundary), so the same mock pattern doesn't apply. Every Douyin API call
 * ultimately reaches `page.evaluate(<fetch script>)` where the inlined
 * `browserFetch` writes the URL and method via `JSON.stringify(...)` and the
 * POST body as `body: JSON.stringify(<json-literal>)`.
 *
 * This helper provides a page whose default `evaluate` impl parses that
 * script, recovers `(method, url, body)`, and forwards to a single
 * `page.browserFetch` vi.fn — the seam that mirrors opencli's
 * `browserFetchMock`. The first arg passed to `page.browserFetch` is the fake
 * `page` itself (the bundled adapter calls `browserFetch(page, method, url,
 * opts)`), so assertions compare to `(page, method, url[, opts])`.
 *
 * Mapping vs. opencli test conventions:
 *   opencli                                       → here
 *   ──────────────────────────────────────────────────────────────────────
 *   browserFetchMock.mockResolvedValueOnce(...)   → page.browserFetch.mockResolvedValueOnce(...)
 *   browserFetchMock.mockImplementation(...)      → page.browserFetch.mockImplementation(...)
 *   expect(browserFetchMock).toHaveBeenCalledWith({}, 'GET', url)
 *                                                 → expect(page.browserFetch).toHaveBeenCalledWith(page, 'GET', url)
 *   page.evaluate non-fetch (DOM) result          → page.directEvaluate.mockResolvedValueOnce(...)
 *
 * Routing:
 *   - A script whose first `fetch("...")` literal is an absolute
 *     creator.douyin.com / www.douyin.com URL → `page.browserFetch(page,
 *     method, url, opts)`.
 *   - Anything else (the delete adapter's big DOM-walking evaluate whose first
 *     fetch is the RELATIVE work_list URL, or any other in-page script) →
 *     `page.directEvaluate(script)`.
 *
 * NOTE: the bundled `browserFetch` wraps the raw evaluate result in its own
 * validation (null / array / non-object / status_code !== 0). Because we feed
 * `page.browserFetch`'s resolved value straight back as the evaluate result,
 * tests that want to exercise that validation can resolve a raw payload (e.g.
 * `{ status_code: 401 }`) and the inlined browserFetch will map it just like
 * production. Tests that mock at the browserFetch *return* level (opencli's
 * convention) resolve the already-unwrapped data and the adapter consumes it
 * directly — both work because a well-formed object with no `status_code` (or
 * `status_code: 0`) passes the inlined validation untouched.
 */

import { vi, type Mock } from 'vitest';

const DOUYIN_HOSTS = new Set(['creator.douyin.com', 'www.douyin.com']);

export interface FakeDouyinPage {
  /** Seam mirroring opencli's mocked `browserFetch`. Called as
   * `(page, method, url, { body? })`. */
  browserFetch: Mock<
    (page: FakeDouyinPage, method: string, url: string, opts?: { body?: unknown }) => unknown
  >;
  /** Catch-all for `page.evaluate(...)` scripts that aren't an absolute
   * Douyin-host fetch — e.g. the delete adapter's DOM-walking script. */
  directEvaluate: Mock<(script: string) => unknown>;
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string) => Promise<void>>;
  wait: Mock<(seconds: number) => Promise<void>>;
  scroll: Mock<() => Promise<void>>;
  getCookies: Mock<() => Promise<unknown>>;
}

export function makeFakeDouyinPage(): FakeDouyinPage {
  const page: FakeDouyinPage = {
    browserFetch: vi.fn(),
    directEvaluate: vi.fn(),
    evaluate: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([]),
  };

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake page.evaluate expects a string script');
    }

    // Recover the first fetch URL literal. The inlined browserFetch writes it
    // as `fetch("<url>", {` via JSON.stringify, so it lands double-quoted.
    const urlMatch = script.match(/fetch\((['"`])([^'"`]+)\1/);
    if (urlMatch) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(urlMatch[2], 'http://placeholder.invalid');
      } catch {
        parsed = null;
      }
      if (parsed && DOUYIN_HOSTS.has(parsed.hostname)) {
        // Recover the method literal: `method: "GET"`.
        const methodMatch = script.match(/method:\s*(['"`])([^'"`]+)\1/);
        const method = methodMatch ? methodMatch[2] : 'GET';

        // Recover the POST body: the inlined fetch contains
        // `body: JSON.stringify(<json-literal>)`. The <json-literal> is the
        // JSON.stringify of options.body, so it's parseable JSON.
        let body: unknown;
        const bodyMatch = script.match(/body:\s*JSON\.stringify\((\{[\s\S]*?\})\),/);
        if (bodyMatch) {
          try {
            body = JSON.parse(bodyMatch[1]);
          } catch {
            body = undefined;
          }
        }

        const opts = body !== undefined ? { body } : undefined;
        // Use the ORIGINAL absolute URL string (urlMatch[2]) so substring
        // assertions in the tests match exactly what the adapter built.
        return opts
          ? page.browserFetch(page, method, urlMatch[2], opts)
          : page.browserFetch(page, method, urlMatch[2]);
      }
    }

    // Non-Douyin-host fetch or a script with no fetch at all (DOM walkers).
    return page.directEvaluate(script);
  });

  return page;
}
