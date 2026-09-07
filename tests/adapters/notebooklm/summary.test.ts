/**
 * Port of opencli's clis/notebooklm/summary.test.js.
 *
 * Opencli mocks `readNotebooklmSummaryFromPage` (DOM) and
 * `getNotebooklmSummaryViaRpc` (rLM1Ne RPC fallback). Inlined here, so test 1
 * feeds the raw summary-DOM payload (real `parseNotebooklmSummaryRawRow` runs),
 * and test 2 nulls the DOM block and feeds the raw notebook-detail RPC payload
 * so the real RPC summary extractor runs.
 *
 * Mechanism difference for test 2: the real RPC extractor only accepts a
 * candidate summary string of length >= 80, so we hand it an 80+ char string
 * rather than opencli's short stub literal. The behavior under test (DOM-first,
 * then rpc fallback) is preserved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/summary.js';

describe('notebooklm summary (marketplace)', () => {
  const command = findAdapter('notebooklm', 'summary');
  let page = makeFakeNotebooklmPage();

  beforeEach(() => {
    page = makeFakeNotebooklmPage();
    page.setPageState({
      url: 'https://notebooklm.google.com/notebook/nb-demo',
      title: 'Browser Automation',
      hostname: 'notebooklm.google.com',
      kind: 'notebook',
      notebookId: 'nb-demo',
      loginRequired: false,
      notebookCount: 1,
    });
  });

  it('returns the current notebook summary from the visible page first', async () => {
    page.setSummaryRaw({ title: 'Browser Automation', summary: 'A concise notebook summary.' });
    // If the DOM path is taken, the rpc must never be consulted; leaving the
    // detail rpc unset would surface as an error if it were called.

    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        notebook_id: 'nb-demo',
        title: 'Browser Automation',
        summary: 'A concise notebook summary.',
        url: 'https://notebooklm.google.com/notebook/nb-demo',
        source: 'summary-dom',
      },
    ]);
  });

  it('falls back to rpc summary extraction when no visible summary block is found', async () => {
    page.setSummaryRaw(null);
    const rpcSummary =
      'Summary recovered from rpc that is long enough to clear the eighty character minimum length gate.';
    // rLM1Ne notebook-detail payload: detail[0] = title; a >=80 char string at
    // an index other than 0/2/3 becomes the extracted summary.
    page.setRpcResult('rLM1Ne', ['Browser Automation', null, null, null, rpcSummary]);

    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        notebook_id: 'nb-demo',
        title: 'Browser Automation',
        summary: rpcSummary,
        url: 'https://notebooklm.google.com/notebook/nb-demo',
        source: 'rpc',
      },
    ]);
  });
});
