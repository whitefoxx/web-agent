/**
 * Port of opencli's clis/notebooklm/source-get.test.js.
 *
 * Opencli mocks `listNotebooklmSourcesViaRpc` / `listNotebooklmSourcesFromPage`.
 * Inlined here, so test 1 drives the rLM1Ne notebook-detail RPC with a raw
 * payload that the real `parseNotebooklmSourceListResult` turns into the source
 * row (which carries the bundle's full field set: type_code / size /
 * created_at / updated_at — opencli mocked the parser output and asserted a
 * 6-field subset; a faithful mechanism difference). Test 2 empties the rpc and
 * feeds the raw DOM source rows (passed through verbatim).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/source-get.js';

const NB_URL = 'https://notebooklm.google.com/notebook/nb-demo';

describe('notebooklm source-get (marketplace)', () => {
  const command = findAdapter('notebooklm', 'source-get');
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

  it('returns a source by exact id from rpc results', async () => {
    // rLM1Ne detail: [title, [sources...], notebookId, ...]. One source entry:
    //   [id, title, meta] with meta[4]=5 (type code → 'web').
    page.setRpcResult('rLM1Ne', [
      'NB',
      [['src-1', 'Release Notes', [null, null, null, null, 5]]],
      'nb-demo',
    ]);

    const result = await command!.func!(page, { source: 'src-1' });
    expect(result).toEqual([
      {
        id: 'src-1',
        notebook_id: 'nb-demo',
        title: 'Release Notes',
        url: NB_URL,
        source: 'rpc',
        type: 'web',
        type_code: 5,
        size: null,
        created_at: null,
        updated_at: null,
      },
    ]);
  });

  it('falls back to page results and matches by title when rpc is empty', async () => {
    // Empty notebook detail → no parsed sources → rpc rows empty → DOM fallback.
    page.setRpcResult('rLM1Ne', []);
    page.setSourceListDomRaw([
      {
        id: 'Meeting Notes',
        notebook_id: 'nb-demo',
        title: 'Meeting Notes',
        url: NB_URL,
        source: 'current-page',
      },
    ]);

    const result = await command!.func!(page, { source: 'meeting notes' });
    expect(result).toEqual([
      {
        id: 'Meeting Notes',
        notebook_id: 'nb-demo',
        title: 'Meeting Notes',
        url: NB_URL,
        source: 'current-page',
      },
    ]);
  });
});
