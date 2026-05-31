/**
 * Fake page for testing marketplace-bundled notebooklm adapters.
 *
 * Opencli's notebooklm tests do `vi.mock('./utils.js', ...)` to swap out the
 * shared helpers (`getNotebooklmPageState`, `requireNotebooklmSession`,
 * `listNotebooklmSourcesViaRpc`, `readCurrentNotebooklm`, etc.). Our
 * marketplace adapters have all of those helpers INLINED (one esbuild bundle
 * per adapter, no `./utils.js` module boundary), so the same mock pattern
 * doesn't work.
 *
 * Every inlined helper ultimately reaches the page through exactly two seams:
 *   1. `page.evaluate(<extraction script>)` — for DOM/page-state reads and the
 *      auth-token probe.
 *   2. `page.evaluate(<fetch script>)` — for the batchexecute RPC POST.
 *
 * This fake page routes `page.evaluate` by inspecting the script string and
 * returns configurable canned data, so a test configures the page exactly
 * where the opencli test configured the mocked helper:
 *
 *   opencli                                          → here
 *   ────────────────────────────────────────────────────────────────────────
 *   mockGetNotebooklmPageState.mockResolvedValue(s)  → page.setPageState(s)
 *   mockRequireNotebooklmSession.mockResolvedValue() → (implied by a valid
 *                                                       notebook page state)
 *   mockListNotebooklmNotesFromPage.mockResolvedValue→ page.setNoteListRaw(raw)
 *   mockReadNotebooklmVisibleNoteFromPage(...)        → page.setVisibleNoteRaw
 *   mockReadCurrentNotebooklm.mockResolvedValue(c)    → page.setCurrentNotebook
 *   mockReadNotebooklmSummaryFromPage.mockResolvedV.  → page.setSummaryRaw(raw)
 *   mockListNotebooklmSourcesFromPage.mockResolvedV.  → page.setSourceListDom
 *   *ViaRpc helpers (sources / fulltext / guide / …)  → page.setRpcResult(id, …)
 *
 * The `*ViaRpc` helpers in the bundle re-implement opencli's RPC parsing on
 * top of `callNotebooklmRpc`, so instead of returning the final parsed object
 * (which the opencli mock did) we hand back the RAW batchexecute payload for
 * that rpcId and let the inlined parser run for real — that keeps the parser
 * under test rather than stubbed out.
 */

import { vi, type Mock } from 'vitest';

const NOTEBOOKLM_DOMAIN = 'notebooklm.google.com';

export interface NotebooklmPageStateRaw {
  url?: string;
  title?: string;
  hostname?: string;
  kind?: string;
  notebookId?: string;
  loginRequired?: boolean;
  notebookCount?: number;
  path?: string;
}

const DEFAULT_STATE: Required<NotebooklmPageStateRaw> = {
  url: 'https://notebooklm.google.com/notebook/nb-demo',
  title: 'Browser Automation',
  hostname: 'notebooklm.google.com',
  kind: 'notebook',
  notebookId: 'nb-demo',
  loginRequired: false,
  notebookCount: 1,
  path: '/notebook/nb-demo',
};

export interface FakeNotebooklmPage {
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string) => Promise<void>>;
  wait: Mock<(seconds?: number) => Promise<void>>;

  /** Raw page-state object the inlined `getNotebooklmPageState` reads. */
  setPageState(state: NotebooklmPageStateRaw): void;
  /** Auth-probe payload (html containing SNlM0e/FdrFJe + token fallbacks). */
  setAuth(auth: Partial<{ html: string; sourcePath: string; csrfToken: string; sessionId: string; authuser: string }>): void;

  /** Raw rows for the `artifact-library-note` DOM list. */
  setNoteListRaw(rows: Array<{ title: string; text: string }>): void;
  /** Raw row for the visible note editor (`.note-header__editable-title`). */
  setVisibleNoteRaw(raw: { title: string; content: string } | null): void;
  /** Raw row for `readCurrentNotebooklm` (open). */
  setCurrentNotebookRaw(raw: { id: string; title: string; url: string; source?: string } | null): void;
  /** Raw row for `readNotebooklmSummaryFromPage`. */
  setSummaryRaw(raw: { title: string; summary: string } | null): void;
  /** Raw rows for the `选择所有来源` DOM source list. */
  setSourceListDomRaw(rows: unknown[]): void;

  /** RAW batchexecute result (the wrb.fr payload) for one rpcId. */
  setRpcResult(rpcId: string, result: unknown): void;
}

/** Build a batchexecute wire body that `extractNotebooklmRpcResult` parses
 * back into `result` for `rpcId`. Matches the shape pinned by opencli's
 * rpc.test.js: anti-XSSI prefix, a digits length line, then the JSON line. */
function buildRpcWireBody(rpcId: string, result: unknown): string {
  const payload = JSON.stringify(result);
  const line = JSON.stringify([['wrb.fr', rpcId, payload]]);
  return `)]}'\n${line.length}\n${line}`;
}

export function makeFakeNotebooklmPage(): FakeNotebooklmPage {
  let stateRaw: Required<NotebooklmPageStateRaw> = { ...DEFAULT_STATE };
  let authRaw = {
    html: '<html>"SNlM0e":"csrf-123","FdrFJe":"sess-456"</html>',
    sourcePath: '/notebook/nb-demo',
    csrfToken: 'csrf-123',
    sessionId: 'sess-456',
    authuser: '',
  };
  let noteListRaw: Array<{ title: string; text: string }> = [];
  let visibleNoteRaw: { title: string; content: string } | null = null;
  let currentNotebookRaw: { id: string; title: string; url: string; source?: string } | null = null;
  let summaryRaw: { title: string; summary: string } | null = null;
  let sourceListDomRaw: unknown[] = [];
  const rpcResults: Record<string, unknown> = {};

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(),

    setPageState(s: NotebooklmPageStateRaw) {
      stateRaw = { ...DEFAULT_STATE, ...s };
    },
    setAuth(a) {
      authRaw = { ...authRaw, ...a };
    },
    setNoteListRaw(rows) {
      noteListRaw = rows;
    },
    setVisibleNoteRaw(raw) {
      visibleNoteRaw = raw;
    },
    setCurrentNotebookRaw(raw) {
      currentNotebookRaw = raw;
    },
    setSummaryRaw(raw) {
      summaryRaw = raw;
    },
    setSourceListDomRaw(rows) {
      sourceListDomRaw = rows;
    },
    setRpcResult(rpcId, result) {
      rpcResults[rpcId] = result;
    },
  } as FakeNotebooklmPage;

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake notebooklm page.evaluate expects a string script');
    }

    // 1. Auth-token probe (`getNotebooklmPageAuth` → `probeNotebooklmPageAuth`).
    if (script.includes('document.documentElement.innerHTML')) {
      return { ...authRaw };
    }

    // 2. RPC batchexecute fetch (`fetchNotebooklmInPage`). Recover the rpcId
    //    from the URL and synthesize the wire body for the configured result.
    if (script.includes('fetch(request.url')) {
      const urlMatch = script.match(/url:\s*"([^"]+)"/);
      const url = urlMatch ? urlMatch[1] : '';
      const rpcMatch = url.match(/[?&]rpcids=([^&]+)/);
      const rpcId = rpcMatch ? decodeURIComponent(rpcMatch[1]) : '';
      const result = rpcId in rpcResults ? rpcResults[rpcId] : null;
      return {
        ok: true,
        status: 200,
        body: buildRpcWireBody(rpcId, result),
        finalUrl: url,
      };
    }

    // 3. Page-state probe (`getNotebooklmPageState`). Uniquely identified by
    //    the loginRequired + notebookCount derivation.
    if (script.includes('loginRequired') && script.includes('notebookCount')) {
      return { ...stateRaw };
    }

    // 4. Studio note list (`listNotebooklmNotesFromPage`).
    if (script.includes('artifact-library-note')) {
      return noteListRaw;
    }

    // 5. Visible note editor (`readNotebooklmVisibleNoteFromPage`).
    if (script.includes('note-header__editable-title')) {
      return visibleNoteRaw;
    }

    // 6. DOM source list (`listNotebooklmSourcesFromPage`). Checked before the
    //    current-page branch because this script ALSO emits rows tagged
    //    `source: 'current-page'`; the skip-set marker disambiguates it.
    if (script.includes('选择所有来源')) {
      return sourceListDomRaw;
    }

    // 7. Current notebook metadata (`readCurrentNotebooklm`, open).
    if (script.includes("source: 'current-page'")) {
      return currentNotebookRaw;
    }

    // 8. Notebook summary block (`readNotebooklmSummaryFromPage`).
    if (script.includes('notebook-summary') || script.includes('summary-content')) {
      return summaryRaw;
    }

    throw new Error(`fake notebooklm page.evaluate: unrouted script:\n${script.slice(0, 200)}`);
  });

  return page;
}

export { NOTEBOOKLM_DOMAIN };
