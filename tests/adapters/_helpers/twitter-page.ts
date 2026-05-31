/**
 * Fake page for testing marketplace-bundled twitter adapters.
 *
 * Unlike bilibili (whose adapters funnel every call through a single
 * `page.evaluate(<fetch script>)` that we route by URL), the twitter adapters
 * are a grab-bag of seams:
 *
 *   - DOM write-actions (like / unlike / retweet / unretweet / bookmark /
 *     unbookmark / delete / hide-reply): call `page.goto()`, `page.wait()`,
 *     then `page.evaluate(<extraction/click script string>)` ONCE and map the
 *     `{ ok, message }` result to a row. Opencli tests these with a queue of
 *     `page.evaluate` results plus assertions on the script string content.
 *     → use {@link createPageMock} (a faithful port of opencli's
 *       clis/test-utils.js createPageMock).
 *
 *   - GraphQL read/management commands (profile / followers / following /
 *     likes / tweets / search / lists / list-* / bookmark-folder(s) /
 *     device-follow): call `page.getCookies()`, `page.goto()`,
 *     `page.evaluate(<queryId resolver>)`, then `page.evaluate(<graphql fetch>)`
 *     — sometimes as a STRING template, sometimes as a FUNCTION with extra
 *     args. Opencli tests these by building ad-hoc page objects whose
 *     `evaluate` branches on `String(script).includes('/SomeOperation')`.
 *     Those tests port verbatim (they construct the page inline with `vi`),
 *     so this helper just re-exports `vi` for convenience and offers
 *     {@link makeCookiePage} for the common `{ goto, wait, getCookies,
 *     evaluate }` skeleton.
 *
 * No URL-routing layer is needed here because opencli's own twitter tests
 * already drive `page.evaluate` directly by string-matching; we keep that
 * mechanism and only swap the registry lookup + error imports per the port
 * cheatsheet.
 */

import { vi, type Mock } from 'vitest';

export interface FakeTwitterPage {
  goto: Mock;
  tabs: Mock;
  selectTab: Mock;
  closeTab: Mock;
  newTab: Mock;
  evaluate: Mock;
  snapshot: Mock;
  screenshot: Mock;
  click: Mock;
  nativeClick: Mock;
  typeText: Mock;
  pressKey: Mock;
  scrollTo: Mock;
  scroll: Mock;
  autoScroll: Mock;
  setFileInput: Mock;
  getFormState: Mock;
  networkRequests: Mock;
  consoleMessages: Mock;
  installInterceptor: Mock;
  getInterceptedRequests: Mock;
  waitForCapture: Mock;
  startNetworkCapture: Mock;
  readNetworkCapture: Mock;
  getCookies: Mock;
  wait: Mock;
  [k: string]: unknown;
}

/**
 * Faithful port of opencli's clis/test-utils.js `createPageMock`. Seeds
 * `page.evaluate` with a queue of sequential resolved values and provides
 * every standard browser-automation method as a resolving `vi.fn()`.
 *
 * @param evaluateResults Sequential results for `page.evaluate()` calls.
 * @param overrides Override or add mock methods.
 */
export function createPageMock(
  evaluateResults: unknown[] = [],
  overrides: Record<string, unknown> = {},
): FakeTwitterPage {
  const evaluate = vi.fn();
  for (const result of evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    selectTab: vi.fn().mockResolvedValue(undefined),
    closeTab: vi.fn().mockResolvedValue(undefined),
    newTab: vi.fn().mockResolvedValue(undefined),

    evaluate,
    snapshot: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(''),

    click: vi.fn().mockResolvedValue(undefined),
    nativeClick: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scrollTo: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    autoScroll: vi.fn().mockResolvedValue(undefined),
    setFileInput: vi.fn().mockResolvedValue(undefined),

    getFormState: vi.fn().mockResolvedValue({ forms: [], orphanFields: [] }),

    networkRequests: vi.fn().mockResolvedValue([]),
    consoleMessages: vi.fn().mockResolvedValue([]),

    installInterceptor: vi.fn().mockResolvedValue(undefined),
    getInterceptedRequests: vi.fn().mockResolvedValue([]),
    waitForCapture: vi.fn().mockResolvedValue(undefined),

    startNetworkCapture: vi.fn().mockResolvedValue(undefined),
    readNetworkCapture: vi.fn().mockResolvedValue([]),

    getCookies: vi.fn().mockResolvedValue([]),

    wait: vi.fn().mockResolvedValue(undefined),

    ...overrides,
  } as FakeTwitterPage;
}

export { vi };
