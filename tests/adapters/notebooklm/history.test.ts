/**
 * Port of opencli's clis/notebooklm/history.test.js.
 *
 * Opencli mocks `getNotebooklmPageState` / `requireNotebooklmSession` /
 * `listNotebooklmHistoryViaRpc`. Those are inlined in the bundle, so we drive
 * the seams below them: the fake page returns a valid `notebook` page-state and
 * routes the two batchexecute RPCs (`hPTbtc` threads list, `khqZz` thread
 * detail) so the real `listNotebooklmHistoryViaRpc` produces the row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/history.js';

describe('notebooklm history (marketplace)', () => {
  const command = findAdapter('notebooklm', 'history');
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

  it('lists notebook history threads from the browser rpc', async () => {
    const threadId = '28e0f2cb-4591-45a3-a661-7653666f7c78';
    // hPTbtc → the threads-list RPC: thread ids are collected from the tree.
    page.setRpcResult('hPTbtc', [[threadId]]);
    // khqZz → the per-thread detail RPC: item_count = result.length, preview =
    // first non-uuid, non-numeric string.
    page.setRpcResult('khqZz', ['Summarize this notebook']);

    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        notebook_id: 'nb-demo',
        thread_id: threadId,
        item_count: 1,
        preview: 'Summarize this notebook',
        url: 'https://notebooklm.google.com/notebook/nb-demo',
        source: 'rpc',
      },
    ]);
  });
});
