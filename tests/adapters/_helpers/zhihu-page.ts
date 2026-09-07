/**
 * Fake page for testing marketplace-bundled zhihu adapters.
 *
 * Unlike bilibili (whose bundled apiGet/apiPost helpers sign + reshape the
 * request, so the test must route the fetched URL through vi.fn()s), zhihu's
 * bundled adapters have their fetch logic inlined directly into a
 * `page.evaluate(<async IIFE that does fetch(<literal url>, {credentials})>)`
 * call. The IIFE returns the parsed JSON body, or a sentinel envelope on
 * failure ({ __httpError }, { __malformedJson }, { __fetchError }).
 *
 * That `page.evaluate` boundary is EXACTLY where opencli's own tests mock —
 * they do `evaluate: vi.fn().mockResolvedValue(<payload>)` and assert
 * substrings on `evaluate.mock.calls[i][0]` (the script source). So the
 * faithful port keeps the same seam: mock `page.evaluate` directly. There is
 * no URL router or apiGet/apiPost indirection to recover here.
 *
 * This helper just constructs the plain fake page with the methods the zhihu
 * adapters touch, each a vi.fn(). Tests then drive `page.evaluate` with
 * `mockResolvedValue` / `mockResolvedValueOnce` / `mockImplementation` exactly
 * as the opencli tests do. Write adapters additionally use `page.wait`; the
 * read adapters that resolve a canonical question id use `page.getCurrentUrl`.
 *
 * `opts` lets a test omit methods (e.g. drop `getCurrentUrl` to exercise the
 * adapter's `page.getCurrentUrl ? ... : ''` guard, or drop `wait`).
 */

import { vi, type Mock } from 'vitest';

export interface FakeZhihuPage {
  goto: Mock;
  wait: Mock;
  evaluate: Mock;
  getCurrentUrl?: Mock;
}

export interface MakeFakeZhihuPageOpts {
  /** Include a `getCurrentUrl` vi.fn() (some read adapters probe it). Default true. */
  withGetCurrentUrl?: boolean;
  /** Include a `wait` vi.fn() (write adapters call page.wait). Default true. */
  withWait?: boolean;
}

export function makeFakeZhihuPage(opts: MakeFakeZhihuPageOpts = {}): FakeZhihuPage {
  const { withGetCurrentUrl = true, withWait = true } = opts;
  const page: FakeZhihuPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: withWait ? vi.fn().mockResolvedValue(undefined) : vi.fn(),
    evaluate: vi.fn(),
  };
  if (withGetCurrentUrl) {
    page.getCurrentUrl = vi.fn().mockResolvedValue('');
  }
  return page;
}
