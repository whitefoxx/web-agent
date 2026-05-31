/**
 * Fake page for testing marketplace-bundled xiaohongshu adapters.
 *
 * Unlike bilibili/douyin (whose adapters route every API call through an
 * inlined `apiGet`/`browserFetch` that writes a literal fetch URL), the
 * xiaohongshu adapters drive the browser almost entirely through
 * `page.evaluate(<DOM or in-page-fetch script>)` and assert on the SEQUENCE
 * of `page.evaluate` return values (or on a script-content router). Opencli's
 * own tests use a plain `createPageMock(evaluateResult)` whose `evaluate` is a
 * `vi.fn()` resolving canned values — so the porting work here is mostly
 * mechanical: swap the registry lookup (`findAdapter`) and the error imports,
 * and reuse the exact same page shape.
 *
 * `makeFakeXiaohongshuPage()` returns a page with every method opencli's
 * createPageMock exposed, all as `vi.fn()`s resolving sane defaults. By
 * default `page.evaluate` resolves `undefined`. Callers configure it the same
 * way opencli's tests do:
 *
 *   // single canned value for ALL evaluate calls (opencli createPageMock(x)):
 *   page.evaluate.mockResolvedValue(x)
 *
 *   // a sequence (opencli createPageMock([a, …, z]) → first=a, rest=last):
 *   setEvaluateSequence(page, [a, b, c])     // a, then b, then c… (c repeats)
 *
 *   // a content router (opencli's note-detail func tests):
 *   page.evaluate.mockImplementation(async (script) => { … })
 *
 * The first arg of `func` is the fake page itself: call `command.func(page,
 * kwargs)` — identical to opencli, which also passed its page object first.
 */

import { vi, type Mock } from 'vitest';

export interface FakeXiaohongshuPage {
  goto: Mock;
  evaluate: Mock;
  snapshot: Mock;
  click: Mock;
  typeText: Mock;
  pressKey: Mock;
  scrollTo: Mock;
  getFormState: Mock;
  wait: Mock;
  tabs: Mock;
  selectTab: Mock;
  networkRequests: Mock;
  consoleMessages: Mock;
  scroll: Mock;
  autoScroll: Mock;
  installInterceptor: Mock;
  getInterceptedRequests: Mock;
  getCookies: Mock;
  screenshot: Mock;
  waitForCapture: Mock;
}

/**
 * Mirror of opencli's createPageMock — every method a `vi.fn()` resolving the
 * same defaults opencli used. `evaluate` resolves `undefined` until a test
 * configures it. `getInterceptedRequests` lets the creator-notes API-fallback
 * path return canned intercepted entries (opencli passed these as the second
 * createPageMock arg).
 */
export function makeFakeXiaohongshuPage(
  interceptedRequests: unknown[] = [],
): FakeXiaohongshuPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    snapshot: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scrollTo: vi.fn().mockResolvedValue(undefined),
    getFormState: vi.fn().mockResolvedValue({ forms: [], orphanFields: [] }),
    wait: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    selectTab: vi.fn().mockResolvedValue(undefined),
    networkRequests: vi.fn().mockResolvedValue([]),
    consoleMessages: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    installInterceptor: vi.fn().mockResolvedValue(undefined),
    getInterceptedRequests: vi.fn().mockResolvedValue(interceptedRequests),
    getCookies: vi.fn().mockResolvedValue([]),
    screenshot: vi.fn().mockResolvedValue(''),
    waitForCapture: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Configure `page.evaluate` to resolve the given sequence, matching opencli's
 * `createPageMock(Array)` semantics EXACTLY: the first call returns seq[0],
 * and every call thereafter returns the LAST element (so a trailing repeating
 * value can stand in for an unbounded poll loop).
 */
export function setEvaluateSequence(
  page: FakeXiaohongshuPage,
  seq: unknown[],
): void {
  const fn = vi.fn();
  fn.mockResolvedValueOnce(seq[0]).mockResolvedValue(seq[seq.length - 1]);
  page.evaluate = fn;
}

/**
 * Configure `page.evaluate` to resolve each element of the sequence in order
 * with NO repeating tail (matching opencli tests that chain
 * `.mockResolvedValueOnce(...)` N times then fall through to undefined).
 */
export function setEvaluateOnceSequence(
  page: FakeXiaohongshuPage,
  seq: unknown[],
): void {
  const fn = vi.fn();
  for (const value of seq) fn.mockResolvedValueOnce(value);
  fn.mockResolvedValue(undefined);
  page.evaluate = fn;
}
