/**
 * Port of opencli's clis/gemini/ask.test.js.
 *
 * Opencli mocked the high-level utils helpers (readGeminiSnapshot,
 * sendGeminiMessage, waitForGeminiSubmission, waitForGeminiResponse) and
 * asserted the remaining-timeout arithmetic by inspecting the 4th arg passed to
 * the mocked waitForGeminiResponse. Those helpers are INLINED in our bundle and
 * are NOT exported, so they can't be intercepted at the module boundary.
 *
 * Faithful-port shift (MECHANISM only — behavior preserved):
 *  - We drive the REAL inlined orchestration through the page seam: the fake
 *    page's evalSnapshot returns (a) a baseline, (b) a confirmed-submission
 *    snapshot, then (c) a stable assistant-reply snapshot, so the real
 *    waitForGeminiSubmission + waitForGeminiResponse run end-to-end and the
 *    command returns the assistant text.
 *  - The remaining-timeout budget assertion is observed OBSERVABLY: Date.now is
 *    stubbed exactly as opencli did (start, then post-submission). When the
 *    submission consumes the WHOLE budget, the computed remaining timeout is 0,
 *    and the inlined waitForGeminiResponse short-circuits to '' (its
 *    `if (timeoutSeconds <= 0) return ''`), which surfaces as the NO-RESPONSE
 *    message — the same control-flow opencli pinned with
 *    `toHaveBeenCalledWith(page, submission, prompt, 0)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeGeminiPage, makeSnapshot, type FakeGeminiPage } from '../_helpers/gemini-page.js';

import '../../../marketplace/gemini/ask.js';

describe('gemini ask orchestration (marketplace)', () => {
  const command = findAdapter('gemini', 'ask');
  let page: FakeGeminiPage = makeFakeGeminiPage();

  // Snapshot that confirms submission on the first poll: composer cleared,
  // generation underway, no turns yet.
  const confirmedSubmission = () => makeSnapshot({ composerHasText: false, isGenerating: true });
  // A stable, finished reply snapshot carrying one appended Assistant turn.
  const replySnapshot = (text: string) =>
    makeSnapshot({ composerHasText: false, isGenerating: false, turns: [{ Role: 'Assistant', Text: text }] });

  beforeEach(() => {
    page = makeFakeGeminiPage();
    page.evalPrepareComposer.mockResolvedValue({ ok: true, label: 'Enter a prompt for Gemini' });
    page.evalInsertText.mockResolvedValue({ hasText: true });
    page.evalSubmitComposer.mockResolvedValue('button');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures baseline, sends, waits for confirmed submission, then returns the assistant reply', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2000);
    page.evalSnapshot
      .mockResolvedValueOnce(makeSnapshot()) // baseline read
      .mockResolvedValueOnce(confirmedSubmission()) // submission poll → confirmed
      .mockResolvedValue(replySnapshot('OK')); // response polls → stable 'OK'

    const result = await command!.func!(page, { prompt: '请只回复：OK', timeout: 20, new: 'false' });

    // sent through the composer (one submit), no new-chat since new=false
    expect(page.evalSubmitComposer).toHaveBeenCalledTimes(1);
    expect(page.evalNewChat).not.toHaveBeenCalled();
    expect(result).toEqual([{ response: '💬 OK' }]);
  });

  it('does not spend extra response wait time after submission consumed the full timeout budget', async () => {
    // start at 0, post-submission at 20000 → remaining budget 0 → the inlined
    // waitForGeminiResponse returns '' immediately, yielding the NO-RESPONSE
    // message (opencli pinned this as waitForGeminiResponse called with 0).
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(20000);
    page.evalSnapshot
      .mockResolvedValueOnce(makeSnapshot()) // baseline read
      .mockResolvedValueOnce(confirmedSubmission()) // submission poll → confirmed
      .mockResolvedValue(replySnapshot('OK')); // would be a reply, but budget is 0

    const result = await command!.func!(page, { prompt: '请只回复：OK', timeout: 20, new: 'false' });

    expect(result).toEqual([
      { response: '💬 [NO RESPONSE] No Gemini response within 20s.' },
    ]);
  });

  it('starts a new chat first when new=true', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1000);
    page.evalNewChat.mockResolvedValue('clicked');
    page.evalSnapshot
      .mockResolvedValueOnce(makeSnapshot())
      .mockResolvedValueOnce(confirmedSubmission())
      .mockResolvedValue(replySnapshot('hi'));

    const result = await command!.func!(page, { prompt: 'hello', timeout: 20, new: 'true' });

    expect(page.evalNewChat).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ response: '💬 hi' }]);
  });

  it('returns NO-RESPONSE when the submission is never confirmed', async () => {
    page.evalSnapshot.mockResolvedValue(makeSnapshot()); // never changes → null submission
    const result = await command!.func!(page, { prompt: 'hello', timeout: 6, new: 'false' });
    expect(result).toEqual([{ response: '💬 [NO RESPONSE] No Gemini response within 6s.' }]);
  });
});
