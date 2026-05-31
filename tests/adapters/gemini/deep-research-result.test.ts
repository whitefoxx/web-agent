/**
 * Port of opencli's clis/gemini/deep-research-result.test.js.
 *
 * Opencli mocked the high-level utils helpers (getGeminiPageState,
 * getGeminiConversationList, resolveGeminiConversationForQuery,
 * clickGeminiConversationByTitle, waitForGeminiTranscript,
 * exportGeminiDeepResearchReport, getLatestGeminiAssistantResponse,
 * readGeminiSnapshot). Those are INLINED in our bundle, so the fake page routes
 * the underlying `page.evaluate(<script>)` calls to per-helper vi.fn()s.
 *
 * Notable faithful-port shifts:
 *  - `resolveGeminiConversationForQuery` is a PURE inlined function (not
 *    interceptable), so the "passes query and mode into …" opencli assertion
 *    can't observe a mock call. We instead assert the OBSERVABLE result the
 *    resolver produces (the matched conversation is opened by URL). The pure
 *    resolver still runs for real.
 *  - opencli mocked `exportGeminiDeepResearchReport` to return `{ url, source }`
 *    directly. We hand the RAW export-script payload to `evalExport` and let the
 *    real `exportGeminiDeepResearchReport` + `pickGeminiDeepResearchExportUrl`
 *    scoring run, so a `.md` export URL scores high enough to be selected.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeGeminiPage, makeSnapshot, type FakeGeminiPage } from '../_helpers/gemini-page.js';

import '../../../marketplace/gemini/deep-research-result.js';

const REPORT_URL = 'https://files.example.com/report.md';
const CONV = { Title: 'A title', Url: 'https://gemini.google.com/app/abc' };

describe('gemini/deep-research-result (marketplace)', () => {
  const command = findAdapter('gemini', 'deep-research-result');
  let page: FakeGeminiPage = makeFakeGeminiPage();

  const exportFound = () => ({ ok: true, currentUrl: CONV.Url, urls: [REPORT_URL] });
  const exportNone = () => ({ ok: false, currentUrl: CONV.Url, urls: [] });

  beforeEach(() => {
    page = makeFakeGeminiPage();
    // Default happy state: signed in, one conversation, transcript present,
    // export yields the report URL, latest assistant response present.
    page.evalState.mockResolvedValue({ isSignedIn: true, canSend: true, url: CONV.Url });
    page.evalConversationList.mockResolvedValue([{ title: CONV.Title, url: CONV.Url }]);
    page.evalClickConversation.mockResolvedValue(true);
    page.evalTranscript.mockResolvedValue(['line']);
    page.evalExport.mockResolvedValue(exportFound());
    page.setLatestAssistantResponse('Final answer');
    page.evalSnapshot.mockResolvedValue(makeSnapshot());
  });

  const runCommand = (kwargs: Record<string, unknown>) =>
    command!.func!(page, { timeout: 120, ...kwargs });

  it('uses latest conversation when query is empty', async () => {
    const result = await runCommand({ query: '   ' });
    expect(page.goto).toHaveBeenCalledWith(CONV.Url, { waitUntil: 'load', settleMs: 2500 });
    expect(result).toEqual([{ response: REPORT_URL }]);
  });

  it('falls back to current page response when query is empty and sidebar has no conversations', async () => {
    page.evalConversationList.mockResolvedValue([]);
    const result = await runCommand({ query: '' });
    expect(page.goto).not.toHaveBeenCalled();
    expect(result).toEqual([{ response: REPORT_URL }]);
  });

  it('returns a validation message when match mode is invalid', async () => {
    const result = await runCommand({ query: 'A', match: 'prefix' });
    expect(result).toEqual([{ response: 'Invalid match mode. Use contains or exact.' }]);
  });

  it('returns a signed-out message when Gemini page state indicates logged out', async () => {
    page.evalState.mockResolvedValue({ isSignedIn: false, canSend: false, url: CONV.Url });
    const result = await runCommand({ query: 'A' });
    expect(result).toEqual([{ response: 'Not signed in to Gemini.' }]);
  });

  it('opens matched conversation by URL and returns exported report url', async () => {
    const result = await runCommand({ query: 'A title', match: 'exact' });
    expect(page.goto).toHaveBeenCalledWith(CONV.Url, { waitUntil: 'load', settleMs: 2500 });
    expect(result).toEqual([{ response: REPORT_URL }]);
  });

  it('accepts a direct conversation URL and reads response from that page', async () => {
    const url = 'https://gemini.google.com/app/direct-id';
    const result = await runCommand({ query: url, match: 'contains' });
    expect(page.goto).toHaveBeenCalledWith(url, { waitUntil: 'load', settleMs: 2500 });
    expect(result).toEqual([{ response: REPORT_URL }]);
  });

  it('resolves the query against the sidebar list and opens the matched conversation', async () => {
    // opencli asserted resolveGeminiConversationForQuery was called with
    // (list, 'title', 'contains'); that resolver is a pure inlined fn here, so
    // we assert the observable effect: the resolved conversation is opened.
    const result = await runCommand({ query: 'title', match: 'contains' });
    expect(page.goto).toHaveBeenCalledWith(CONV.Url, { waitUntil: 'load', settleMs: 2500 });
    expect(result).toEqual([{ response: REPORT_URL }]);
  });

  it('falls back to click-by-title and returns not-found when click fails', async () => {
    // No conversation in the list matches → resolver returns null → contains
    // mode falls back to click-by-title, which fails.
    page.evalConversationList.mockResolvedValue([]);
    page.evalClickConversation.mockResolvedValue(false);
    const result = await runCommand({ query: 'missing', match: 'contains' });
    expect(result).toEqual([{ response: 'No conversation matched: missing' }]);
  });

  it('returns pending message when export url is unavailable and completion is not confirmed', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.setLatestAssistantResponse('Final answer');
    page.evalSnapshot.mockResolvedValue(makeSnapshot({ isGenerating: false, transcriptLines: [] }));
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([
      { response: 'Deep Research may still be running or preparing export. Please wait and retry later.' },
    ]);
  });

  it('returns waiting message when deep research is still generating', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.evalSnapshot.mockResolvedValue(makeSnapshot({ isGenerating: true }));
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([{ response: 'Deep Research is still running. Please wait and retry later.' }]);
  });

  it('returns waiting message when assistant response indicates research in progress', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.evalSnapshot.mockResolvedValue(makeSnapshot({ isGenerating: false }));
    page.setLatestAssistantResponse('正在研究中，请稍候。');
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([{ response: 'Deep Research is still running. Please wait and retry later.' }]);
  });

  it('returns waiting message when transcript indicates in-progress status', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.setLatestAssistantResponse('');
    page.evalSnapshot.mockResolvedValue(
      makeSnapshot({ isGenerating: false, transcriptLines: ['生成研究计划中，请稍候。'] }),
    );
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([{ response: 'Deep Research is still running. Please wait and retry later.' }]);
  });

  it('returns no-docs message when text indicates completed state', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.setLatestAssistantResponse('Researching websites... Completed');
    page.evalSnapshot.mockResolvedValue(makeSnapshot({ isGenerating: false, transcriptLines: [] }));
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([
      { response: 'No Docs URL found. Please check Share & Export -> Export to Docs in Gemini UI.' },
    ]);
  });

  it('returns pending message when assistant response is empty', async () => {
    page.evalExport.mockResolvedValue(exportNone());
    page.setLatestAssistantResponse('');
    page.evalSnapshot.mockResolvedValue(makeSnapshot({ isGenerating: false, transcriptLines: [] }));
    const result = await runCommand({ query: 'A title' });
    expect(result).toEqual([
      { response: 'Deep Research may still be running or preparing export. Please wait and retry later.' },
    ]);
  });
});
