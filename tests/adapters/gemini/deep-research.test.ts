/**
 * Port of opencli's clis/gemini/deep-research.test.js.
 *
 * Opencli mocked the high-level utils helpers (getCurrentGeminiUrl,
 * readGeminiSnapshot, selectGeminiTool, sendGeminiMessage, startNewGeminiChat,
 * waitForGeminiSubmission, waitForGeminiConfirmButton,
 * getLatestGeminiAssistantResponse) and asserted on their call counts/args.
 * Those are INLINED in our bundle, so the fake page routes the underlying
 * `page.evaluate(<script>)` calls to per-helper vi.fn()s.
 *
 * Faithful-port shifts (MECHANISM only — behavior preserved):
 *  - `selectGeminiTool` count is observed via `evalSelectTool` (the inlined
 *    helper makes exactly one selectGeminiToolScript eval per invocation).
 *  - `sendGeminiMessage` count is observed via `evalSubmitComposer` (one submit
 *    per send).
 *  - `startNewGeminiChat` count is observed via `evalNewChat`.
 *  - `waitForGeminiSubmission` is a poller over readGeminiSnapshot; we make the
 *    snapshot decisive on the FIRST poll (confirmed submission) or always-stale
 *    (never confirms → null), and use a small per-call timeout so submission
 *    polling is cheap. Opencli's "returns submission object | null" maps to
 *    "snapshot confirms | snapshot never changes".
 *  - `waitForGeminiConfirmButton` is a poller over clickGeminiConfirmButtonScript;
 *    with timeout 1 it polls exactly once, so `evalConfirmButton`
 *    mockResolvedValueOnce(...) sequences map 1:1 to opencli's
 *    waitForGeminiConfirmButton invocation results. The confirm-label set is
 *    asserted by inspecting the script the eval received.
 *  - `getCurrentGeminiUrl` reads the bare `window.location.href` probe; we drive
 *    it with page.setCurrentUrl / page.queueCurrentUrl, mirroring opencli's
 *    mockGetCurrentGeminiUrl.mockResolvedValue(Once).
 *  - `getLatestGeminiAssistantResponse` reads turns then transcript; driven via
 *    page.setLatestAssistantResponse.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeGeminiPage, makeSnapshot, type FakeGeminiPage } from '../_helpers/gemini-page.js';

import '../../../marketplace/gemini/deep-research.js';

const APP_CHAT = 'https://gemini.google.com/app/chat';
const APP_ROOT = 'https://gemini.google.com/app';

describe('gemini/deep-research (marketplace)', () => {
  const command = findAdapter('gemini', 'deep-research');
  let page: FakeGeminiPage = makeFakeGeminiPage();

  // A snapshot that confirms a submission on the first poll (composer cleared,
  // generation underway) — the "composer_generating" path of
  // waitForGeminiSubmission.
  const confirmedSubmissionSnapshot = () =>
    makeSnapshot({ composerHasText: false, isGenerating: true });
  // A snapshot that never satisfies a submission (composer empty, not
  // generating, no turns/transcript delta) → waitForGeminiSubmission returns
  // null after exhausting its polls.
  const staleSnapshot = () => makeSnapshot({ composerHasText: false, isGenerating: false });

  beforeEach(() => {
    page = makeFakeGeminiPage();
    page.setCurrentUrl(APP_CHAT);
    page.evalNewChat.mockResolvedValue('clicked');
    page.evalOpenToolsMenu.mockResolvedValue(true);
    page.evalSelectTool.mockResolvedValue('Deep Research');
    page.evalInsertText.mockResolvedValue({ hasText: true });
    page.evalSubmitComposer.mockResolvedValue('button');
    page.evalSnapshot.mockResolvedValue(confirmedSubmissionSnapshot());
    page.evalConfirmButton.mockResolvedValue('Start research');
    page.setLatestAssistantResponse('');
  });

  // timeout 1 keeps confirm polling at exactly one poll per invocation, so
  // evalConfirmButton mockResolvedValueOnce sequences map 1:1 to opencli's
  // waitForGeminiConfirmButton invocation results.
  const runCommand = (kwargs: Record<string, unknown>) =>
    command!.func!(page, { timeout: 1, ...kwargs });

  it('starts a new chat by default, then sends prompt and confirms deep research', async () => {
    const result = await runCommand({ prompt: 'research this topic' });
    expect(page.evalNewChat).toHaveBeenCalledTimes(1);
    expect(page.evalSelectTool).toHaveBeenCalledTimes(1);
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1); // one send
    // confirm received the default Start-research label set
    const confirmScript = String(page.evalConfirmButton.mock.calls[0]?.[0] ?? '');
    expect(confirmScript).toContain('Start research');
    expect(confirmScript).toContain('Start deep research');
    expect(confirmScript).toContain('Generate research plan');
    expect(confirmScript).toContain('生成研究计划');
    expect(result).toEqual([{ status: 'started', url: APP_CHAT }]);
  });

  it('returns tool-not-found when the tool cannot be selected', async () => {
    page.evalSelectTool.mockResolvedValue('');
    const result = await runCommand({ prompt: 'research this topic' });
    expect(result).toEqual([{ status: 'tool-not-found', url: APP_CHAT }]);
    expect(page.evalSubmitComposer).not.toHaveBeenCalled(); // no send
    expect(page.evalConfirmButton).not.toHaveBeenCalled();
  });

  it('retries send once when first submission cannot be confirmed', async () => {
    // First submission poll batch never confirms; after re-select + re-send the
    // snapshot confirms.
    page.evalSnapshot
      .mockResolvedValueOnce(staleSnapshot()) // baseline read (attempt 1)
      .mockResolvedValue(confirmedSubmissionSnapshot());
    // Force attempt-1 submission to fail: make ALL of attempt-1's poll reads
    // stale, then attempt-2 confirm. Easiest: stale for the whole first
    // submission window, then confirmed. We emulate by returning stale until a
    // re-select happens. Use a counter keyed off evalSelectTool calls.
    let selectCalls = 0;
    page.evalSelectTool.mockImplementation(async () => {
      selectCalls += 1;
      return 'Deep Research';
    });
    page.evalSnapshot.mockImplementation(async () =>
      selectCalls >= 2 ? confirmedSubmissionSnapshot() : staleSnapshot(),
    );
    const result = await runCommand({ prompt: 'research this topic' });
    expect(page.evalSelectTool).toHaveBeenCalledTimes(2); // re-select on retry
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(2); // re-send on retry
    expect(result).toEqual([{ status: 'started', url: APP_CHAT }]);
  });

  it('returns submit-not-found when submission cannot be confirmed after retry', async () => {
    page.evalSnapshot.mockResolvedValue(staleSnapshot()); // never confirms
    const result = await runCommand({ prompt: 'research this topic' });
    expect(page.evalSelectTool).toHaveBeenCalledTimes(2); // re-select on retry
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(2); // re-send on retry
    expect(page.evalConfirmButton).not.toHaveBeenCalled();
    expect(result).toEqual([{ status: 'submit-not-found', url: APP_CHAT }]);
  });

  it('returns confirm-not-found when no confirm button is found', async () => {
    page.evalConfirmButton.mockResolvedValue('');
    page.setLatestAssistantResponse('');
    const result = await runCommand({ prompt: 'research this topic' });
    expect(result).toEqual([{ status: 'confirm-not-found', url: APP_CHAT }]);
  });

  it('returns started when confirm is missing but research appears to be running', async () => {
    page.evalConfirmButton.mockResolvedValue('');
    page.setCurrentUrl('https://gemini.google.com/app/abc123');
    page.setLatestAssistantResponse('Researching websites now');
    const result = await runCommand({ prompt: 'research this topic' });
    expect(result).toEqual([{ status: 'started', url: 'https://gemini.google.com/app/abc123' }]);
  });

  it('does not treat conversation url alone as started when confirm is missing', async () => {
    page.evalConfirmButton.mockResolvedValue('');
    page.setCurrentUrl('https://gemini.google.com/app/abc999');
    page.setLatestAssistantResponse('I drafted a plan. Start research');
    const result = await runCommand({ prompt: 'research this topic' });
    expect(result).toEqual([{ status: 'confirm-not-found', url: 'https://gemini.google.com/app/abc999' }]);
  });

  it('retries once when stuck on root app URL and starts successfully on second confirm', async () => {
    // After the FIRST confirm, getCurrentGeminiUrl must see the root app URL
    // (false positive → root-retry path). After the SECOND confirm it must see
    // a real conversation URL. Drive currentUrl from the confirm-button mock so
    // the value is set exactly when each confirm fires (every
    // `window.location.href` probe then reflects the right value).
    page.setCurrentUrl(APP_CHAT);
    let confirmCalls = 0;
    page.evalConfirmButton.mockImplementation(async () => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        page.setCurrentUrl(APP_ROOT);
        return '';
      }
      page.setCurrentUrl('https://gemini.google.com/app/retry123');
      return 'Start research';
    });
    const result = await runCommand({ prompt: 'research this topic', timeout: 1 });
    expect(page.evalSelectTool).toHaveBeenCalledTimes(2); // re-select on root retry
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1); // no re-send on root retry
    expect(page.evalConfirmButton).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ status: 'started', url: 'https://gemini.google.com/app/retry123' }]);
  });

  it('treats root-url confirm as false-positive and retries', async () => {
    page.setCurrentUrl(APP_CHAT);
    let confirmCalls = 0;
    page.evalConfirmButton.mockImplementation(async () => {
      confirmCalls += 1;
      // both confirms succeed; first is on the root URL (false positive),
      // second on a real conversation URL.
      page.setCurrentUrl(confirmCalls === 1 ? APP_ROOT : 'https://gemini.google.com/app/retry456');
      return 'Start research';
    });
    const result = await runCommand({ prompt: 'research this topic', timeout: 1 });
    expect(page.evalSelectTool).toHaveBeenCalledTimes(2); // re-select on root retry
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1); // no re-send on root retry
    expect(result).toEqual([{ status: 'started', url: 'https://gemini.google.com/app/retry456' }]);
  });

  it('does not resend prompt during root-url retry to avoid duplicate chats', async () => {
    page.setCurrentUrl(APP_ROOT);
    let confirmCalls = 0;
    page.evalConfirmButton.mockImplementation(async () => {
      confirmCalls += 1;
      page.setCurrentUrl(APP_ROOT); // stays on root the whole time
      return confirmCalls === 1 ? 'Start research' : '';
    });
    page.setLatestAssistantResponse('');
    const result = await runCommand({ prompt: 'research this topic', timeout: 1 });
    expect(page.evalSelectTool).toHaveBeenCalledTimes(2); // re-select on root retry
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1); // no re-send on root retry
    expect(page.evalConfirmButton).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ status: 'confirm-not-found', url: APP_ROOT }]);
  });

  it('attempts one more confirm click when still waiting for start research', async () => {
    // url is a real conversation (not root) so the root-retry branch is
    // skipped; the first confirm misses, the assistant text says it is waiting
    // for "Start research" (waitingForStart, not researching), which triggers a
    // single fallback confirm that then succeeds and the text flips to
    // "Researching".
    page.setCurrentUrl('https://gemini.google.com/app/xyz123');
    let confirmCalls = 0;
    page.evalConfirmButton.mockImplementation(async () => {
      confirmCalls += 1;
      return confirmCalls === 1 ? '' : 'Start research';
    });
    let latestCalls = 0;
    page.evalTurns.mockImplementation(async () => {
      latestCalls += 1;
      const text = latestCalls === 1 ? 'I drafted a plan. Start research' : 'Researching websites now';
      return [{ Role: 'Assistant', Text: text }];
    });
    const result = await runCommand({ prompt: 'research this topic', timeout: 1 });
    expect(page.evalConfirmButton).toHaveBeenCalledTimes(2);
    // the fallback (2nd) confirm uses the merged default label set, which
    // includes the Chinese Start-research labels.
    const fallbackScript = String(page.evalConfirmButton.mock.calls[1]?.[0] ?? '');
    expect(fallbackScript).toContain('Start research');
    expect(fallbackScript).toContain('开始研究');
    expect(fallbackScript).toContain('开始深度研究');
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ status: 'started', url: 'https://gemini.google.com/app/xyz123' }]);
  });

  it('uses custom tool/confirm labels when provided', async () => {
    await runCommand({
      prompt: 'research this topic',
      tool: 'Custom Tool',
      confirm: 'Custom Confirm',
      timeout: 42,
    });
    const selectScript = String(page.evalSelectTool.mock.calls[0]?.[0] ?? '');
    expect(selectScript).toContain('Custom Tool');
    const confirmScript = String(page.evalConfirmButton.mock.calls[0]?.[0] ?? '');
    expect(confirmScript).toContain('Custom Confirm');
  });
});
