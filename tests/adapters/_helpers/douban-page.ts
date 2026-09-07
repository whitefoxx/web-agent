/**
 * Fake page for testing marketplace-bundled douban adapters.
 *
 * Unlike bilibili (whose bundled apiGet/apiPost helpers sign + reshape a fetch
 * URL we must parse), douban's bundled adapters are pure DOM scrapers. Each
 * `func` does:
 *
 *   page.goto(<url>) → ensureDoubanReady(page) → page.wait(...) →
 *   page.evaluate(<DOM extraction script>) → reshape/validate the result.
 *
 * Both the readiness probe AND the data extraction reach the SAME boundary:
 * `page.evaluate(<string script>)`. opencli's own douban tests are
 * metadata-only (they never drive func), but the func paths ARE reachable, so
 * this helper makes them testable by routing the two kinds of evaluate calls:
 *
 *   1. ensureDoubanReady's probe — its script tests `location.href.includes(
 *      'sec.douban.com')` and document.title. We recognize it by the literal
 *      `sec.douban.com` and serve `page.readyState` (default { blocked:false }).
 *      Tests can set `page.readyState = { blocked: true }` to exercise the
 *      AUTH_REQUIRED branch.
 *
 *   2. every OTHER evaluate (the data-extraction script) is forwarded to
 *      `page.extract`, a vi.fn() the test arms with canned scraped data via
 *      `mockResolvedValue` / `mockResolvedValueOnce`. This mirrors how opencli
 *      mocks page.evaluate to return parsed rows.
 *
 * `goto`, `wait`, `getCookies`, `scroll` are vi.fn()s that resolve, matching
 * the no-op browser methods the adapters await.
 *
 * Mapping vs. opencli conventions:
 *   getRegistry().get('douban/x')                → findAdapter('douban', 'x')
 *   '@jackwener/opencli/errors'                  → '../../../src/runtime/errors.js'
 *   page.evaluate.mockResolvedValue(<rows>)      → page.extract.mockResolvedValue(<rows>)
 *   command.func(page, kwargs)                   → command.func(page, kwargs)
 */

import { vi, type Mock } from 'vitest';

export interface FakeDoubanPage {
  /** Result served to ensureDoubanReady's probe. Default: not blocked. */
  readyState: { blocked: boolean; title?: string; href?: string };
  /** Canned return value for the DOM-extraction evaluate call(s). */
  extract: Mock<(script: string) => unknown>;
  /** Underlying evaluate the adapter calls; routes probe vs. extraction. */
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string, opts?: unknown) => Promise<void>>;
  wait: Mock<(opts?: unknown) => Promise<void>>;
  getCookies: Mock<() => Promise<unknown>>;
  scroll: Mock<() => Promise<void>>;
}

export function makeFakeDoubanPage(): FakeDoubanPage {
  const page: FakeDoubanPage = {
    readyState: { blocked: false },
    extract: vi.fn(),
    evaluate: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    // page.wait is called both as page.wait(4) (number) and
    // page.wait({ selector, timeout }) — and the adapter does
    // `.catch(() => {})` on the selector form, so resolving is correct.
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue(undefined),
  };

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake page.evaluate expects a string script');
    }
    // ensureDoubanReady's probe is the only script that references
    // sec.douban.com — serve the (overridable) readiness verdict.
    if (script.includes('sec.douban.com')) {
      return page.readyState;
    }
    // Everything else is a data-extraction script.
    return page.extract(script);
  });

  return page;
}
