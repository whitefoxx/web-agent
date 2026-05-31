/**
 * Fake page for testing marketplace-bundled bilibili adapters.
 *
 * Opencli's tests do `vi.mock('./utils.js', () => ({ apiGet: mockFn, ... }))`
 * to swap out the shared API helpers. Our marketplace adapters have those
 * helpers INLINED (no module boundary), so the same mock pattern doesn't
 * work. Instead, every API call ultimately reaches `page.evaluate(<fetch
 * script>)`. This helper provides a page whose default `evaluate` impl
 * parses that script, recovers `(method, path, params)`, and forwards to
 * `page.apiGet` / `page.apiPost` — which are themselves `vi.fn()` instances
 * exposing the familiar `mockResolvedValueOnce` / `toHaveBeenNthCalledWith`
 * surface.
 *
 * Mapping vs. opencli test conventions:
 *   opencli                                  → here
 *   ─────────────────────────────────────────────────────────────────────
 *   mockApiGet.mockResolvedValueOnce(...)    → page.apiGet.mockResolvedValueOnce(...)
 *   expect(mockApiGet).toHaveBeenNth...      → expect(page.apiGet).toHaveBeenNth...
 *   page.evaluate.mockResolvedValueOnce(...) → page.directEvaluate.mockResolvedValueOnce(...)
 *
 * The first arg of `page.apiGet`/`page.apiPost` is the fake `page` itself
 * (matches what the bundled adapter actually passes through). Opencli used
 * `{}` because its mock was at the utils module level; here the page IS
 * the call site.
 *
 * Signed GETs: wbi-signing appends `wts`/`w_rid` to the URL. The router
 * strips them before passing `params` to `page.apiGet` and sets
 * `signed: true` in the opts so assertions compare to ORIGINAL params
 * (matching opencli's mockApiGet args).
 */

import { vi, type Mock } from 'vitest';

type ApiOpts = { params: Record<string, string>; signed?: true };

export interface FakeBilibiliPage {
  apiGet: Mock<(page: FakeBilibiliPage, path: string, opts: ApiOpts) => unknown>;
  apiPost: Mock<(page: FakeBilibiliPage, path: string, opts: ApiOpts) => unknown>;
  /** Catch-all for `page.evaluate(...)` calls that aren't an api.bilibili.com
   * fetch — e.g. subtitle-file JSON fetches from third-party hosts. */
  directEvaluate: Mock<(script: string) => unknown>;
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string) => Promise<void>>;
  /** Returned to the nav fetch that wbi-signing performs before each signed
   * call. Tests can override before invoking the adapter. The default values
   * produce a deterministic but throwaway mixin key — real md5() runs but
   * the test never asserts on `w_rid`, so its value is irrelevant. */
  navData: unknown;
}

export function makeFakeBilibiliPage(): FakeBilibiliPage {
  const page: FakeBilibiliPage = {
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    directEvaluate: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    navData: {
      data: {
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png',
        },
      },
    },
    evaluate: vi.fn(),
  };

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake page.evaluate expects a string script');
    }

    // wbi-signing nav prefetch — always served from page.navData.
    if (script.includes('/x/web-interface/nav')) {
      return page.navData;
    }

    // Parse the fetched URL. Bundled apiGet/apiPost write the URL via
    // JSON.stringify, so it lands as a single- or double-quoted literal.
    const urlMatch = script.match(/fetch\((['"`])([^'"`]+)\1/);
    if (urlMatch) {
      // Tolerate //-relative URLs (subtitle files) by giving URL() a base.
      let parsed: URL;
      try {
        parsed = new URL(urlMatch[2], 'http://placeholder.invalid');
      } catch {
        return page.directEvaluate(script);
      }
      if (parsed.hostname === 'api.bilibili.com') {
        const isPost = /method:\s*['"]POST['"]/.test(script);
        if (isPost) {
          // apiPost embeds params as JSON.stringify({...}) inside
          // `new URLSearchParams(...)`. Recover them by extracting the
          // object literal — safe because keys/values are stringified.
          const bodyMatch = script.match(/new URLSearchParams\((\{[\s\S]*?\})\)/);
          let params: Record<string, string> = {};
          if (bodyMatch) {
            try {
              params = JSON.parse(bodyMatch[1]);
            } catch {
              // Fall through with empty params; the test will likely fail an
              // arg assertion, which is the right signal.
            }
          }
          return page.apiPost(page, parsed.pathname, { params });
        }

        // GET. Recover params from the query string. Strip the wbi-signing
        // params (wts + w_rid) so the assertion matches the ORIGINAL opts
        // the adapter passed, not the signed superset.
        const params: Record<string, string> = {};
        for (const [k, v] of parsed.searchParams) params[k] = v;
        const signed = 'wts' in params && 'w_rid' in params;
        if (signed) {
          delete params.wts;
          delete params.w_rid;
        }
        const opts: ApiOpts = signed ? { params, signed: true } : { params };
        return page.apiGet(page, parsed.pathname, opts);
      }
    }

    // Anything else — subtitle file fetches, page-scoped DOM queries, etc.
    return page.directEvaluate(script);
  });

  return page;
}
