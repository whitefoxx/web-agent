/**
 * Fake page helpers for testing marketplace-bundled LinkedIn adapters.
 *
 * Unlike bilibili (whose adapters route every call through a single
 * `page.evaluate(<fetch script>)` to api.bilibili.com), the LinkedIn adapters
 * are DOM-driven: they call `page.goto`, `page.wait`, `page.autoScroll`,
 * `page.getCookies`, and `page.evaluate(<extraction script>)` where the script
 * is a literal that LinkedIn's real browser would run. In the unit tests we
 * never run those scripts — instead the fake `page.evaluate` returns canned
 * extraction payloads, exactly like opencli's own tests did.
 *
 * Opencli's linkedin tests each define a small inline page factory. We mirror
 * that shape here so any test can build a page with the methods the bundled
 * adapter actually crosses. Most adapters' substantive coverage is through
 * exported pure helpers (`__test__`), so this helper is only needed for the
 * handful of `command.func` integration tests.
 *
 * Notes vs opencli conventions:
 *   - The bundled adapters call `unwrapEvaluateResult()` on every
 *     `page.evaluate` result; it passes through plain objects unchanged (only
 *     unwraps `{ data, session }` bridge envelopes), so returning the raw
 *     payload from `evaluate` works the same as in opencli.
 *   - `page.evaluate` is the seam where DOM extraction is mocked. When an
 *     adapter makes several evaluate calls (auth probe, then extraction, then
 *     dialog, etc.), use a sequenced mock (`mockResolvedValueOnce` chains) or
 *     route by script content, matching opencli's own test factories.
 */

import { vi, type Mock } from 'vitest';

export interface FakeLinkedInPage {
  goto: Mock;
  wait: Mock;
  autoScroll: Mock;
  scroll: Mock;
  getCookies: Mock;
  evaluate: Mock;
}

const DEFAULT_COOKIES = [{ name: 'JSESSIONID', value: '"ajax:1234567890"' }];

/**
 * Build a fake LinkedIn page. `evaluate` is left as a bare `vi.fn()` so each
 * test can drive it with `.mockResolvedValueOnce(...)` chains or a routing
 * `.mockImplementation(...)`, exactly like opencli's inline factories.
 */
export function makeFakeLinkedInPage(
  opts: {
    cookies?: unknown;
    evaluate?: Mock;
  } = {},
): FakeLinkedInPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    getCookies: vi
      .fn()
      .mockResolvedValue(opts.cookies === undefined ? DEFAULT_COOKIES : opts.cookies),
    evaluate: opts.evaluate ?? vi.fn(),
  };
}
