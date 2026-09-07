/**
 * Fake page for testing marketplace-bundled claude adapters.
 *
 * Opencli's claude tests do `vi.mock('./utils.js', ...)` to swap out the shared
 * high-level helpers (`ensureOnClaude`, `ensureClaudeComposer`, `selectModel`,
 * `setAdaptiveThinking`, `sendMessage`, `sendWithFile`, `getBubbleCount`,
 * `waitForResponse`, `withRetry`, …). Our marketplace adapters have ALL of those
 * helpers INLINED (one esbuild bundle per adapter, no `./utils.js` module
 * boundary), so the same module-level mock pattern can't be used.
 *
 * Every inlined helper ultimately reaches the page through a small set of seams:
 * `page.evaluate(<distinct script>)`, `page.goto`, `page.wait`, and (for the
 * file flow) `page.setFileInput`. This fake page routes `page.evaluate` by
 * inspecting the script string (each inlined helper emits a recognizable script)
 * and forwards to a per-script `vi.fn()` that exposes the familiar
 * `mockResolvedValue` / `mockResolvedValueOnce` surface — so a test configures
 * the page exactly where the opencli test configured the mocked helper:
 *
 *   opencli                                              → here
 *   ────────────────────────────────────────────────────────────────────────────
 *   mockEnsureClaudeComposer.mockResolvedValue({...})    → page.evalState.mockResolvedValue({...})
 *   mockSelectModel.mockResolvedValue({ ok:true })       → page.evalSelectModelOpen / evalSelectModelPick
 *   mockSetAdaptiveThinking.mockResolvedValue({...})     → page.evalThinkOpen / evalThinkPick
 *   mockSendMessage.mockResolvedValue({ ok:true })       → page.evalComposerClear/evalSend (and assert prompt via evalInsertText)
 *   mockGetBubbleCount.mockResolvedValue(3)              → page.evalBubbleCount.mockResolvedValue(3)
 *   mockWaitForResponse.mockResolvedValue('hi')          → page.setAssistantResponse('hi')
 *   mockSendWithFile.mockResolvedValue({ ok:true })      → file scripts default to success; failures via setFileFailure / page.setFileInput
 *
 * Because `ensureOnClaude` / the func's `currentUrl` probe call
 * `page.evaluate("window.location.href")`, the fake answers that probe from
 * `currentUrl` (default `https://claude.ai/new`) so no spurious
 * `page.goto(CLAUDE_URL)` navigation happens. Tests override / queue it with
 * `page.setCurrentUrl(...)` / `page.queueCurrentUrl(...)`, matching opencli's
 * `page.evaluate.mockResolvedValue('https://claude.ai/chat/abc-123')`.
 */

import { vi, type Mock } from 'vitest';

const CLAUDE_DOMAIN = 'claude.ai';
const CLAUDE_DEFAULT_URL = 'https://claude.ai/new';

// Capture the genuine Date.now ONCE at module load, before any page patches it.
// Each makeFakeClaudePage() re-patches Date.now to read its own virtual offset
// on top of this real clock, so repeated calls (one per test) never compound.
const REAL_DATE_NOW = Date.now.bind(Date);

export interface FakeClaudePageState {
  url: string;
  title: string;
  hasComposer: boolean;
  isLoggedIn: boolean;
}

export interface FakeClaudePage {
  evaluate: Mock<(script: string) => unknown>;
  goto: Mock<(url: string) => Promise<void>>;
  wait: Mock<(arg?: unknown) => Promise<void>>;
  /** Present in the bundled adapter's optional-native-type branch; left
   * undefined by default so sendMessage uses the DOM execCommand path. */
  nativeType?: Mock<(text: string) => Promise<void>>;
  /** Optional file-input setter. Defined (resolving) by default so the file
   * flow goes through the setFileInput branch rather than the base64 fallback. */
  setFileInput: Mock<(paths: string[], selector: string) => Promise<void>>;

  /** `page.evaluate("window.location.href")` answer. Default a /new URL so
   * `ensureOnClaude` is a no-op. */
  setCurrentUrl(url: string): void;
  queueCurrentUrl(...urls: string[]): void;

  /** getPageState — { url, title, hasComposer, isLoggedIn }. Drives
   * ensureClaudeComposer / ensureClaudeLogin. */
  evalState: Mock<(script: string) => unknown>;

  /** selectModel step 1: open the dropdown → { ok, toggled? , opened? }. */
  evalSelectModelOpen: Mock<(script: string) => unknown>;
  /** selectModel step 2: pick the model menuitemradio → { ok, toggled? , upgrade? }. */
  evalSelectModelPick: Mock<(script: string) => unknown>;

  /** setAdaptiveThinking step 1: open the dropdown → { ok }. */
  evalThinkOpen: Mock<(script: string) => unknown>;
  /** setAdaptiveThinking step 2: toggle the Adaptive thinking menuitem → { ok, toggled? }. */
  evalThinkPick: Mock<(script: string) => unknown>;

  /** sendMessage step 1: composer focus + clear → boolean ready. */
  evalComposerClear: Mock<(script: string) => unknown>;
  /** sendMessage step 2 (fallback path): execCommand('insertText') of the prompt. */
  evalInsertText: Mock<(script: string) => unknown>;
  /** sendMessage step 3: click the Send button → { ok, method? }. */
  evalSend: Mock<(script: string) => unknown>;

  /** getBubbleCount — number of `.font-claude-response` nodes. */
  evalBubbleCount: Mock<(script: string) => unknown>;

  /** waitForResponse poll — { count, last, streaming }. Prefer
   * `setAssistantResponse(text)` to drive it. */
  evalWaitResponse: Mock<(script: string) => unknown>;

  /** func's navigated-link click ( a[href*="/chat/"] ). */
  evalNavLink: Mock<(script: string) => unknown>;

  /** sendWithFile: file-input onChange fire → { ok, via? }. */
  evalFileInputChange: Mock<(script: string) => unknown>;
  /** sendWithFile: waitForFilePreview probe → boolean ready. */
  evalFilePreview: Mock<(script: string) => unknown>;

  /** Convenience: make waitForResponse resolve to `text` (stable, non-streaming,
   * count above baseline). Empty/null → waitForResponse returns null. */
  setAssistantResponse(text: string | null): void;
}

const DEFAULT_STATE: FakeClaudePageState = {
  url: CLAUDE_DEFAULT_URL,
  title: 'Claude',
  hasComposer: true,
  isLoggedIn: true,
};

export function makeFakeClaudePage(): FakeClaudePage {
  let currentUrl = CLAUDE_DEFAULT_URL;
  const urlQueue: string[] = [];

  // Virtual clock for waitForResponse's wall-clock loop. The bundled
  // `waitForResponse` does `while (Date.now() - start < timeoutMs) { await
  // page.wait(3); ... }`. Our `page.wait` resolves instantly, so without a
  // controlled clock the null/no-response path would spin for the full real
  // timeout (e.g. 60s). We patch Date.now to read a virtual `nowOffset` that
  // `page.wait(seconds)` advances — every poll moves the clock forward by the
  // wait duration, so the loop terminates after a deterministic number of
  // iterations (timeoutMs / waitMs) with no real sleeping.
  let nowOffset = 0;
  Date.now = () => REAL_DATE_NOW() + nowOffset;

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn(async (arg?: unknown) => {
      // Numeric arg = "wait N seconds". Advance the virtual clock so the
      // polling loop makes progress toward its timeout. Object arg (selector
      // wait) does not consume loop time.
      if (typeof arg === 'number' && arg > 0) {
        nowOffset += arg * 1000;
      }
      return undefined;
    }),
    setFileInput: vi.fn().mockResolvedValue(undefined),
    nativeType: undefined as unknown,
    evaluate: vi.fn(),

    evalState: vi.fn().mockResolvedValue({ ...DEFAULT_STATE }),
    evalSelectModelOpen: vi.fn().mockResolvedValue({ ok: true, opened: true }),
    evalSelectModelPick: vi.fn().mockResolvedValue({ ok: true, toggled: true }),
    evalThinkOpen: vi.fn().mockResolvedValue({ ok: true }),
    evalThinkPick: vi.fn().mockResolvedValue({ ok: true, toggled: false }),
    evalComposerClear: vi.fn().mockResolvedValue(true),
    evalInsertText: vi.fn().mockResolvedValue(undefined),
    evalSend: vi.fn().mockResolvedValue({ ok: true }),
    evalBubbleCount: vi.fn().mockResolvedValue(0),
    evalWaitResponse: vi.fn().mockResolvedValue({ count: 1, last: 'hello there', streaming: false }),
    evalNavLink: vi.fn().mockResolvedValue(undefined),
    evalFileInputChange: vi.fn().mockResolvedValue({ ok: true, via: 'react' }),
    evalFilePreview: vi.fn().mockResolvedValue(true),

    setCurrentUrl(url: string) {
      currentUrl = url;
    },
    queueCurrentUrl(...urls: string[]) {
      urlQueue.push(...urls);
    },
    setAssistantResponse(text: string | null) {
      const trimmed = text == null ? '' : String(text);
      if (trimmed) {
        // Stable across the 3 required identical polls; count above any
        // realistic baseline so `result.count <= baselineCount` never trips.
        page.evalWaitResponse.mockResolvedValue({ count: 999, last: trimmed, streaming: false });
      } else {
        // No new bubble → waitForResponse loops until timeout → returns null.
        page.evalWaitResponse.mockResolvedValue({ count: 0, last: '', streaming: false });
      }
    },
  } as unknown as FakeClaudePage & { nativeType: unknown };

  page.evaluate.mockImplementation(async (script: unknown) => {
    if (typeof script !== 'string') {
      throw new Error('fake claude page.evaluate expects a string script');
    }

    // isOnClaude / func currentUrl probe — bare `window.location.href`.
    if (script.trim() === 'window.location.href') {
      return urlQueue.length > 0 ? urlQueue.shift() : currentUrl;
    }

    // waitForResponse poll — the only script reading `data-is-streaming`,
    // returning { count, last, streaming }. Checked FIRST among DOM scripts:
    // its inline comment mentions "Adaptive thinking" and it queries
    // `.font-claude-response`, so it would otherwise be mis-routed to the
    // think-pick or getBubbleCount branch.
    if (script.includes('data-is-streaming')) {
      return page.evalWaitResponse(script);
    }

    // getPageState — the only script reading both the composer and the
    // user-menu-button to compute { hasComposer, isLoggedIn }.
    if (script.includes('user-menu-button') && script.includes('isLoggedIn')) {
      return page.evalState(script);
    }

    // selectModel step 1 (open): reads the model dropdown's aria-label and may
    // return { opened: true }. Distinct from setAdaptiveThinking's open script
    // by the aria-label read.
    if (script.includes('model-selector-dropdown') && script.includes("getAttribute('aria-label')")) {
      return page.evalSelectModelOpen(script);
    }

    // selectModel step 2 (pick): iterates menuitemradio options.
    if (script.includes('menuitemradio')) {
      return page.evalSelectModelPick(script);
    }

    // setAdaptiveThinking step 1 (open): opens the same dropdown but only
    // clicks the trigger (no aria-label read) — handled after selectModel-open.
    if (script.includes('model-selector-dropdown') && script.includes('trigger.click()')) {
      return page.evalThinkOpen(script);
    }

    // setAdaptiveThinking step 2 (pick): toggles the 'Adaptive thinking'
    // menuitem. Require the menuitem-role query so this can't collide with the
    // waitForResponse script (whose comment also mentions "Adaptive thinking").
    if (script.includes('Adaptive thinking') && script.includes('menuitem')) {
      return page.evalThinkPick(script);
    }

    // sendMessage step 1: composer focus + clear via execCommand('delete').
    if (script.includes("execCommand('delete'")) {
      return page.evalComposerClear(script);
    }

    // sendMessage step 2 (DOM fallback insert): execCommand('insertText', ...).
    if (script.includes("execCommand('insertText'")) {
      return page.evalInsertText(script);
    }

    // sendMessage step 3: click the Send button.
    if (script.includes('Send Message') || script.includes('send button not found')) {
      return page.evalSend(script);
    }

    // getBubbleCount — the bare count of `.font-claude-response` nodes.
    // (The waitForResponse script also queries `.font-claude-response` but is
    // already routed above via its `data-is-streaming` marker.)
    if (script.includes('font-claude-response') && script.includes('.length')) {
      return page.evalBubbleCount(script);
    }

    // func navigated-link click — clicks an existing /chat/ anchor.
    if (script.includes('a[href*="/chat/"]')) {
      return page.evalNavLink(script);
    }

    // sendWithFile: file-input onChange dispatch ( file-upload input ).
    if (script.includes('file-upload') && script.includes('onChange')) {
      return page.evalFileInputChange(script);
    }

    // sendWithFile base64 fallback (only if setFileInput absent) — same seam.
    if (script.includes('DataTransfer') && script.includes('file-upload')) {
      return page.evalFileInputChange(script);
    }

    // waitForFilePreview probe — looks for file-thumbnail / Remove button.
    if (script.includes('file-thumbnail') || script.includes("'Remove'")) {
      return page.evalFilePreview(script);
    }

    throw new Error(`fake claude page.evaluate: unrouted script:\n${script.slice(0, 200)}`);
  });

  return page;
}

export { CLAUDE_DOMAIN, CLAUDE_DEFAULT_URL };
