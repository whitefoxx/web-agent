/**
 * Port of opencli's clis/notebooklm/source-fulltext.test.js.
 *
 * Opencli mocks `listNotebooklmSourcesViaRpc` / `listNotebooklmSourcesFromPage`
 * / `getNotebooklmSourceFulltextViaRpc`. Inlined here, so we:
 *   - drive rLM1Ne (notebook detail) so the real source-list parser yields the
 *     row that gets matched by id/title, and
 *   - drive hizoJc (fulltext) with a raw payload that the real
 *     `parseNotebooklmSourceFulltextResult` reconstructs into the fulltext row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/source-fulltext.js';

const NB_URL = 'https://notebooklm.google.com/notebook/nb-demo';

// hizoJc fulltext payload: [ [sourceId, title, meta], _, _, [contentRoot] ]
//   meta[4] = kind code (2 → 'generated-text'); meta[7] = [url]
//   contentRoot leaf strings are joined by '\n' to form content.
const FULLTEXT_RPC = [
  ['src-1', '粘贴的文字', [null, null, null, null, 2, null, null, ['https://example.com/source']]],
  null,
  null,
  [['第一段', '第二段']],
];

const EXPECTED_FULLTEXT = {
  source_id: 'src-1',
  notebook_id: 'nb-demo',
  title: '粘贴的文字',
  kind: 'generated-text',
  content: '第一段\n第二段',
  char_count: 7,
  url: 'https://example.com/source',
  source: 'rpc',
};

describe('notebooklm source-fulltext (marketplace)', () => {
  const command = findAdapter('notebooklm', 'source-fulltext');
  let page = makeFakeNotebooklmPage();

  beforeEach(() => {
    page = makeFakeNotebooklmPage();
    page.setPageState({
      url: NB_URL,
      title: 'Browser Automation',
      hostname: 'notebooklm.google.com',
      kind: 'notebook',
      notebookId: 'nb-demo',
      loginRequired: false,
      notebookCount: 1,
    });
  });

  it('returns fulltext for a source matched from rpc source rows', async () => {
    // rLM1Ne detail with one pasted-text source (type code 8).
    page.setRpcResult('rLM1Ne', [
      'NB',
      [['src-1', '粘贴的文字', [null, null, null, null, 8]]],
      'nb-demo',
    ]);
    page.setRpcResult('hizoJc', FULLTEXT_RPC);

    const result = await command!.func!(page, { source: 'src-1' });
    expect(result).toEqual([EXPECTED_FULLTEXT]);
  });

  it('matches by title from dom rows when rpc source list is unavailable', async () => {
    // Empty notebook detail → rpc source rows empty → DOM fallback supplies the
    // matchable row; fulltext still comes from hizoJc.
    page.setRpcResult('rLM1Ne', []);
    page.setSourceListDomRaw([
      {
        id: 'src-1',
        notebook_id: 'nb-demo',
        title: '粘贴的文字',
        url: NB_URL,
        source: 'current-page',
      },
    ]);
    page.setRpcResult('hizoJc', FULLTEXT_RPC);

    const result = await command!.func!(page, { source: '粘贴的文字' });
    expect(result).toEqual([
      expect.objectContaining({
        source_id: 'src-1',
        title: '粘贴的文字',
        content: '第一段\n第二段',
      }),
    ]);
  });
});
