/**
 * Port of opencli's clis/notebooklm/source-guide.test.js.
 *
 * Opencli mocks `listNotebooklmSourcesViaRpc` / `listNotebooklmSourcesFromPage`
 * / `getNotebooklmSourceGuideViaRpc`. Inlined here, so we drive rLM1Ne (notebook
 * detail) to yield the matchable source row, and tr032e (guide) with a raw
 * payload the real `parseNotebooklmSourceGuideResult` turns into the guide row.
 * The guide row's source_id/notebook_id/title/type come from the matched source
 * row; summary/keywords come from the tr032e payload.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/source-guide.js';

const NB_URL = 'https://notebooklm.google.com/notebook/nb-demo';

// tr032e guide payload: [ [ guide ] ] where guide = [_, [summary], [[keywords]]].
function guideRpc(summary: string, keywords: string[]): unknown {
  return [[[null, [summary], [keywords]]]];
}

describe('notebooklm source-guide (marketplace)', () => {
  const command = findAdapter('notebooklm', 'source-guide');
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

  it('returns source guide for a source matched from rpc source rows', async () => {
    // rLM1Ne detail with one youtube source (type code 9).
    page.setRpcResult('rLM1Ne', [
      'NB',
      [['src-yt', 'Video Source', [null, null, null, null, 9]]],
      'nb-demo',
    ]);
    page.setRpcResult('tr032e', guideRpc('Guide summary.', ['AI', 'agents']));

    const result = await command!.func!(page, { source: 'src-yt' });
    expect(result).toEqual([
      {
        source_id: 'src-yt',
        notebook_id: 'nb-demo',
        title: 'Video Source',
        type: 'youtube',
        summary: 'Guide summary.',
        keywords: ['AI', 'agents'],
        source: 'rpc',
      },
    ]);
  });

  it('matches by title from dom rows when rpc source list is unavailable', async () => {
    page.setRpcResult('rLM1Ne', []);
    page.setSourceListDomRaw([
      {
        id: 'src-1',
        notebook_id: 'nb-demo',
        title: 'Example Source',
        url: NB_URL,
        source: 'current-page',
      },
    ]);
    page.setRpcResult('tr032e', guideRpc('Guide summary.', ['topic']));

    const result = await command!.func!(page, { source: 'example source' });
    expect(result).toEqual([
      expect.objectContaining({
        source_id: 'src-1',
        title: 'Example Source',
        summary: 'Guide summary.',
      }),
    ]);
  });
});
