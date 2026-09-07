/**
 * Fake page(s) for testing marketplace-bundled youtube adapters.
 *
 * YouTube's bundled adapters do NOT cross a single api-host fetch boundary the
 * way bilibili does (where one `page.evaluate(<fetch script>)` carries the URL
 * we can parse). Instead each adapter builds a big self-contained async-IIFE
 * script string and hands it to `page.evaluate(script)`; what the Node-side
 * `func` inspects is the RETURN VALUE of that evaluate. Two distinct seams are
 * used by the opencli youtube tests, both reproduced here:
 *
 *   1. makeFeedFetchPage({ initialData, continuationData, fetchImpl })
 *      — feed's seam. `evaluate` REALLY evals the script with `globalThis.window`
 *        (carrying `ytInitialData` + `ytcfg`) and `globalThis.fetch` mocked, so the
 *        in-page extraction + pagination loop run for real. The script body is a
 *        bare expression `(async () => {...})()`, so `eval()` returns its promise.
 *        Mirrors opencli feed.test.js's `makePage`.
 *
 *   2. makeTranscriptPage() — transcript's seam. `evaluate`, `startNetworkCapture`,
 *      `readNetworkCapture` are plain vi.fn()s; tests pre-arm them with sequenced
 *      `mockResolvedValueOnce(...)` canned payloads. The script strings are never
 *      executed (only their text is asserted in a couple of tests via
 *      page.evaluate.mock.calls[i][0]). Mirrors opencli transcript.test.js's
 *      `createPageMock` and the inline page objects.
 *
 * Mapping vs. opencli test conventions:
 *   opencli                                       → here
 *   ──────────────────────────────────────────────────────────────────────
 *   getRegistry().get('youtube/x')                → findAdapter('youtube', 'x')
 *   import {..} from '@jackwener/opencli/errors'   → '../../../src/runtime/errors.js'
 *   import { __test__ } from './channel.js'        → import { __test__ } from
 *                                                     '../../../marketplace/youtube/channel.js'
 *   readFileSync(resolve(__dirname,'transcript.js'))→ readFileSync of the bundled
 *                                                      marketplace/youtube/transcript.js
 *   command.func(page, kwargs)                     → command.func(page, kwargs)
 */

import { vi, type Mock } from 'vitest';

/* ───────────────────────── feed seam ───────────────────────── */

export interface FakeFeedPage {
  goto: Mock<(url: string) => Promise<void>>;
  wait: Mock<(seconds: number) => Promise<void>>;
  evaluate: Mock<(script: string) => Promise<unknown>>;
  /** The fetch mock used for the continuation (pagination) request, exposed so
   * tests can assert call counts — mirrors opencli's `page.__fetchMock`. */
  __fetchMock: Mock;
}

/**
 * Page whose `evaluate` evals the feed script with `window.ytInitialData` +
 * `window.ytcfg` and `globalThis.fetch` mocked. Mirrors opencli feed.test.js's
 * `makePage`. The continuation fetch resolves to `continuationData` by default;
 * pass `fetchImpl` to override entirely.
 */
export function makeFeedFetchPage({
  initialData,
  continuationData,
  fetchImpl,
}: {
  initialData?: unknown;
  continuationData?: unknown;
  fetchImpl?: Mock;
} = {}): FakeFeedPage {
  const fetchMock =
    fetchImpl ||
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => continuationData,
    });

  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (script: string) => {
      const previousWindow = (globalThis as Record<string, unknown>).window;
      const previousFetch = globalThis.fetch;

      (globalThis as Record<string, unknown>).window = {
        ytInitialData: initialData,
        ytcfg: {
          data_: {
            INNERTUBE_API_KEY: 'test-key',
            INNERTUBE_CONTEXT: { client: { clientName: 'WEB', clientVersion: '1.0' } },
          },
        },
      };
      // @ts-expect-error — looser test fetch signature than DOM fetch
      globalThis.fetch = fetchMock;

      try {
        // eslint-disable-next-line no-eval
        return await eval(script);
      } finally {
        (globalThis as Record<string, unknown>).window = previousWindow;
        globalThis.fetch = previousFetch;
      }
    }),
    __fetchMock: fetchMock,
  };
}

/* ─────────────────────── transcript seam ─────────────────────── */

export interface FakeTranscriptPage {
  goto: Mock<(url: string, opts?: unknown) => Promise<void>>;
  wait: Mock<(seconds: number) => Promise<void>>;
  evaluate: Mock<(script: string) => Promise<unknown>>;
  /** Trampoline-guard probe. Production pages (makeLocalPage / PageShim) always
   * expose this; defaulting to '' here never matches an adapter's "am I on the
   * final page?" guard regex, so navigation runs exactly as before. */
  getCurrentUrl?: Mock<() => Promise<string>>;
  startNetworkCapture?: Mock<(filter: string) => Promise<void>>;
  readNetworkCapture?: Mock<() => Promise<unknown>>;
}

/**
 * Base transcript page: goto/wait/evaluate as vi.fn()s. No network-capture
 * methods — `canCapture` in the adapter is false, so only the in-page evaluate
 * path runs. Mirrors opencli's `createPageMock` skeleton; the caller arms
 * `page.evaluate` with sequenced `mockResolvedValueOnce(...)`.
 */
export function makeTranscriptPage(): FakeTranscriptPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCurrentUrl: vi.fn().mockResolvedValue(''),
    evaluate: vi.fn(),
  };
}

/**
 * Transcript page WITH network-capture methods, for the captured-timedtext
 * paths. `startNetworkCapture`/`readNetworkCapture` are pre-armed vi.fn()s.
 */
export function makeTranscriptCapturePage({
  readNetworkCapture,
}: {
  readNetworkCapture?: unknown;
} = {}): FakeTranscriptPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCurrentUrl: vi.fn().mockResolvedValue(''),
    startNetworkCapture: vi.fn().mockResolvedValue(undefined),
    readNetworkCapture: vi.fn().mockResolvedValue(readNetworkCapture),
    evaluate: vi.fn(),
  };
}
