/**
 * Fake page for testing marketplace-bundled gemini adapters.
 *
 * Opencli's gemini tests do `vi.mock('./utils.js', ...)` to swap out the
 * shared high-level helpers (`readGeminiSnapshot`, `sendGeminiMessage`,
 * `selectGeminiTool`, `getGeminiPageState`, `getGeminiConversationList`,
 * `exportGeminiDeepResearchReport`, `waitForGeminiConfirmButton`, …). Our
 * marketplace adapters have ALL of those helpers INLINED (one esbuild bundle
 * per adapter, no `./utils.js` module boundary), so the same module-level mock
 * pattern can't be used.
 *
 * Every inlined helper ultimately reaches the page through a small set of
 * seams: `page.evaluate(<distinct script>)`, `page.goto`, `page.wait`,
 * `page.tabs`, `page.nativeType`, `page.nativeKeyPress`. This fake page routes
 * `page.evaluate` by inspecting the script string (each helper emits a
 * recognizable script) and forwards to a per-script `vi.fn()` that exposes the
 * familiar `mockResolvedValue` / `mockResolvedValueOnce` surface — so a test
 * configures the page exactly where the opencli test configured the mocked
 * helper:
 *
 *   opencli                                          → here
 *   ──────────────────────────────────────────────────────────────────────────
 *   mockReadGeminiSnapshot.mockResolvedValue(s)      → page.evalSnapshot.mockResolvedValue(s)
 *   mockGetGeminiPageState.mockResolvedValue(s)      → page.evalState.mockResolvedValue(s)
 *   mockGetGeminiConversationList.mockResolvedValue  → page.evalConversationList (raw rows) ...
 *   mockSelectGeminiTool.mockResolvedValue('Deep …') → page.evalSelectTool.mockResolvedValue('Deep …')
 *   mockWaitForGeminiConfirmButton.mockResolvedValue → page.evalConfirmButton.mockResolvedValue(...)
 *   mockGetLatestGeminiAssistantResponse(...)        → page.setLatestAssistantResponse(...)
 *   mockExportGeminiDeepResearchReport(...)          → page.evalExport (raw payload) ...
 *   mockGetCurrentGeminiUrl.mockResolvedValue(url)   → page.setCurrentUrl(url)
 *
 * Because the adapters always start with `ensureGeminiPage(page)` →
 * `isOnGemini(page)` → `page.evaluate("window.location.href")`, the fake page
 * answers that probe from `currentUrl` (default a gemini conversation URL) so
 * no spurious `page.goto(GEMINI_APP_URL)` navigation happens. Tests that care
 * about the URL set it with `page.setCurrentUrl(...)` (optionally a queue via
 * `page.queueCurrentUrl(...)`), matching opencli's
 * `mockGetCurrentGeminiUrl.mockResolvedValueOnce(...)`.
 */

import { vi, type Mock } from 'vitest';

const GEMINI_DOMAIN = 'gemini.google.com';
const GEMINI_DEFAULT_URL = 'https://gemini.google.com/app/abc';

export interface GeminiSnapshot {
  url?: string;
  turns: Array<{ Role: string; Text: string }>;
  transcriptLines: string[];
  composerHasText: boolean;
  isGenerating: boolean;
  structuredTurnsTrusted: boolean;
}

export interface FakeGeminiPage {
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string, opts?: unknown) => Promise<void>>;
  wait: Mock<(seconds?: number) => Promise<void>>;
  tabs: Mock<() => Promise<unknown[]>>;
  nativeType: Mock<(text: string) => Promise<void>>;
  nativeKeyPress: Mock<(key: string) => Promise<void>>;

  /** `page.evaluate("window.location.href")` answer. Default a conversation
   * URL so `ensureGeminiPage` is a no-op. Tests override / queue it to drive
   * `getCurrentGeminiUrl`. */
  setCurrentUrl(url: string): void;
  queueCurrentUrl(...urls: string[]): void;

  /** readGeminiSnapshotScript → snapshot object. */
  evalSnapshot: Mock<(script: string) => unknown>;
  /** getStateScript → page-state object. */
  evalState: Mock<(script: string) => unknown>;
  /** getGeminiConversationListScript → raw [{ title, url }] rows. */
  evalConversationList: Mock<(script: string) => unknown>;
  /** clickGeminiConversationByTitleScript → boolean clicked. */
  evalClickConversation: Mock<(script: string) => unknown>;
  /** getTurnsScript (standalone, via getLatestGeminiAssistantResponse). */
  evalTurns: Mock<(script: string) => unknown>;
  /** getTranscriptLinesScript (standalone). */
  evalTranscript: Mock<(script: string) => unknown>;
  /** exportGeminiDeepResearchReportScript → raw { ok, currentUrl, urls, … }. */
  evalExport: Mock<(script: string) => unknown>;
  /** openGeminiToolsMenuScript → boolean. */
  evalOpenToolsMenu: Mock<(script: string) => unknown>;
  /** selectGeminiToolScript → matched label string. */
  evalSelectTool: Mock<(script: string) => unknown>;
  /** clickGeminiConfirmButtonScript → matched label string. */
  evalConfirmButton: Mock<(script: string) => unknown>;
  /** clickNewChatScript → 'clicked' | 'navigate'. */
  evalNewChat: Mock<(script: string) => unknown>;
  /** prepareComposerScript → { ok, label } | { ok:false, reason }. */
  evalPrepareComposer: Mock<(script: string) => unknown>;
  /** composerHasTextScript → { hasText }. */
  evalComposerHasText: Mock<(script: string) => unknown>;
  /** insertComposerTextFallbackScript → { hasText }. */
  evalInsertText: Mock<(script: string) => unknown>;
  /** submitComposerScript → 'button' | 'enter'. */
  evalSubmitComposer: Mock<(script: string) => unknown>;
  /** dispatchComposerEnterScript → 'enter'. */
  evalDispatchEnter: Mock<(script: string) => unknown>;

  /** Convenience: drive `getLatestGeminiAssistantResponse` (which reads turns
   * via getTurnsScript then falls back to transcript). Sets a single trailing
   * Assistant turn carrying `text`; empty text → no turns + empty transcript. */
  setLatestAssistantResponse(text: string): void;
}

export function makeSnapshot(over: Partial<GeminiSnapshot> = {}): GeminiSnapshot {
  return {
    url: GEMINI_DEFAULT_URL,
    turns: [],
    transcriptLines: [],
    composerHasText: false,
    isGenerating: false,
    structuredTurnsTrusted: true,
    ...over,
  };
}

export function makeFakeGeminiPage(): FakeGeminiPage {
  let currentUrl = GEMINI_DEFAULT_URL;
  const urlQueue: string[] = [];

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    tabs: vi.fn().mockResolvedValue([]),
    nativeType: undefined as unknown,
    nativeKeyPress: undefined as unknown,
    evaluate: vi.fn(),

    evalSnapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    evalState: vi.fn().mockResolvedValue({ isSignedIn: true, canSend: true, url: GEMINI_DEFAULT_URL }),
    evalConversationList: vi.fn().mockResolvedValue([]),
    evalClickConversation: vi.fn().mockResolvedValue(false),
    evalTurns: vi.fn().mockResolvedValue([]),
    evalTranscript: vi.fn().mockResolvedValue([]),
    evalExport: vi.fn().mockResolvedValue({ ok: false, currentUrl: GEMINI_DEFAULT_URL, urls: [] }),
    evalOpenToolsMenu: vi.fn().mockResolvedValue(true),
    evalSelectTool: vi.fn().mockResolvedValue(''),
    evalConfirmButton: vi.fn().mockResolvedValue(''),
    evalNewChat: vi.fn().mockResolvedValue('clicked'),
    evalPrepareComposer: vi.fn().mockResolvedValue({ ok: true, label: 'Enter a prompt for Gemini' }),
    evalComposerHasText: vi.fn().mockResolvedValue({ hasText: true }),
    evalInsertText: vi.fn().mockResolvedValue({ hasText: true }),
    evalSubmitComposer: vi.fn().mockResolvedValue('button'),
    evalDispatchEnter: vi.fn().mockResolvedValue('enter'),

    setCurrentUrl(url: string) {
      currentUrl = url;
    },
    queueCurrentUrl(...urls: string[]) {
      urlQueue.push(...urls);
    },
    setLatestAssistantResponse(text: string) {
      const trimmed = String(text ?? '');
      if (trimmed) {
        page.evalTurns.mockResolvedValue([{ Role: 'Assistant', Text: trimmed }]);
        page.evalTranscript.mockResolvedValue([]);
      } else {
        page.evalTurns.mockResolvedValue([]);
        page.evalTranscript.mockResolvedValue([]);
      }
    },
  } as unknown as FakeGeminiPage & {
    nativeType: unknown;
    nativeKeyPress: unknown;
  };

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake gemini page.evaluate expects a string script');
    }

    // currentUrlScript() — used by isOnGemini / getCurrentGeminiUrl. A bare
    // `window.location.href` with no IIFE wrapper.
    if (script.trim() === 'window.location.href') {
      return urlQueue.length > 0 ? urlQueue.shift() : currentUrl;
    }

    // readGeminiSnapshotScript — the only script carrying `structuredTurnsTrusted`.
    if (script.includes('structuredTurnsTrusted')) {
      return page.evalSnapshot(script);
    }

    // getStateScript — carries `isSignedIn` + `signInNode`.
    if (script.includes('isSignedIn') && script.includes('signInNode')) {
      return page.evalState(script);
    }

    // getGeminiConversationListScript — builds `results.push({ title, url })`.
    if (script.includes('results.push({ title, url })')) {
      return page.evalConversationList(script);
    }

    // clickGeminiConversationByTitleScript — clicks an anchor by title.
    if (script.includes('targetQuery') && script.includes('anchor.click()')) {
      return page.evalClickConversation(script);
    }

    // exportGeminiDeepResearchReportScript — installs the URL recorder.
    if (script.includes('__opencliGeminiExportUrls') || script.includes('recorderKey')) {
      return page.evalExport(script);
    }

    // openGeminiToolsMenuScript — has `menuAlreadyOpen`.
    if (script.includes('menuAlreadyOpen')) {
      return page.evalOpenToolsMenu(script);
    }

    // selectGeminiToolScript — has `menuSelectors`.
    if (script.includes('menuSelectors')) {
      return page.evalSelectTool(script);
    }

    // clickGeminiConfirmButtonScript — has `dialogRoots`.
    if (script.includes('dialogRoots')) {
      return page.evalConfirmButton(script);
    }

    // clickNewChatScript — returns 'navigate' fallback for the new-chat button.
    if (script.includes("'navigate'") && script.includes('new chat')) {
      return page.evalNewChat(script);
    }

    // prepareComposerScript — clears the composer via deleteContentBackward.
    if (script.includes("inputType: 'deleteContentBackward'")) {
      return page.evalPrepareComposer(script);
    }

    // insertComposerTextFallbackScript — uses execCommand('insertText').
    if (script.includes("execCommand('insertText'")) {
      return page.evalInsertText(script);
    }

    // composerHasTextScript — returns just { hasText }.
    if (script.includes('hasText: !!(composer &&')) {
      return page.evalComposerHasText(script);
    }

    // submitComposerScript — scores submit buttons.
    if (script.includes('bestButton') || script.includes('submitPattern')) {
      return page.evalSubmitComposer(script);
    }

    // dispatchComposerEnterScript — dispatches an Enter KeyboardEvent.
    if (script.includes("KeyboardEvent('keydown'")) {
      return page.evalDispatchEnter(script);
    }

    // getTranscriptLinesScript (standalone) — has removableSelectors, no
    // structuredTurnsTrusted (already handled above).
    if (script.includes('removableSelectors')) {
      return page.evalTranscript(script);
    }

    // getTurnsScript (standalone) — has data-message-author-role.
    if (script.includes('data-message-author-role')) {
      return page.evalTurns(script);
    }

    throw new Error(`fake gemini page.evaluate: unrouted script:\n${script.slice(0, 200)}`);
  });

  return page;
}

export { GEMINI_DOMAIN, GEMINI_DEFAULT_URL };
