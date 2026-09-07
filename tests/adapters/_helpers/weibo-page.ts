/**
 * Fake page for testing marketplace-bundled weibo adapters.
 *
 * Unlike bilibili (whose adapters funnel every API call through a single
 * `page.evaluate(<fetch script>)` routed by URL), every weibo adapter here
 * does its real work inside ONE big `page.evaluate(<async fetch/DOM script>)`
 * and reads back a plain JSON payload. There is no signing layer and no
 * per-host routing to recover — the opencli tests just seed `page.evaluate`
 * with canned results and (for delete) assert on the script string.
 *
 * So this helper mirrors opencli's own `makePage` factories rather than the
 * bilibili URL-router. Two shapes are provided:
 *
 *   makeFixedPage(payload)
 *     `page.evaluate` resolves to the SAME `payload` on every call. Matches
 *     opencli's delete.test.js / user-posts.test.js `makePage`, which each
 *     run the adapter's single evaluate.
 *
 *   makeQueuePage([r1, r2, ...])
 *     `page.evaluate` resolves to the queued results in order, but any
 *     `window.scrollBy` scroll script resolves to `undefined` WITHOUT
 *     consuming the queue. Matches opencli's favorites.test.js `makePage`
 *     (uid probe, then card extraction, with 3 interleaved scroll calls).
 *
 * Mapping vs. opencli test conventions:
 *   opencli                          → here
 *   ──────────────────────────────────────────────────────────────────────
 *   getRegistry().get('weibo/x')     → findAdapter('weibo', 'x')   (caller side)
 *   makePage(result)                 → makeFixedPage(result)
 *   makePage([r1, r2])               → makeQueuePage([r1, r2])
 *   page.evaluate.mock.calls[0][0]   → page.evaluate.mock.calls[0][0]  (unchanged)
 */

import { vi, type Mock } from 'vitest';

export interface FakeWeiboPage {
  goto: Mock;
  wait: Mock;
  evaluate: Mock;
  getCurrentUrl?: Mock;
}

/**
 * `page.evaluate` resolves to `payload` on every call. Faithful port of the
 * `makePage` used by delete.test.js and user-posts.test.js.
 */
export function makeFixedPage(payload: unknown): FakeWeiboPage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(payload),
    getCurrentUrl: vi.fn().mockResolvedValue(''),
  };
}

/**
 * `page.evaluate` resolves to the queued results in order. Scroll scripts
 * (`window.scrollBy`) resolve to `undefined` without consuming the queue,
 * so the queue only feeds the real data-extraction evaluations. Faithful
 * port of the `makePage` used by favorites.test.js.
 */
export function makeQueuePage(evaluateResults: unknown[] = []): FakeWeiboPage {
  const queue = [...evaluateResults];
  const evaluate = vi.fn(async (script: unknown) => {
    if (String(script).includes('window.scrollBy')) return undefined;
    return queue.length ? queue.shift() : [];
  });
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate,
    getCurrentUrl: vi.fn().mockResolvedValue(''),
  };
}
