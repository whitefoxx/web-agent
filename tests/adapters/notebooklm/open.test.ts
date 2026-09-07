/**
 * Port of opencli's clis/notebooklm/open.test.js.
 *
 * Opencli mocks `getNotebooklmPageState` / `readCurrentNotebooklm` /
 * `requireNotebooklmSession`. Inlined here, so we feed a notebook page-state
 * for the target id and the raw `readCurrentNotebooklm` DOM payload. We still
 * assert `page.goto` receives the canonical notebook URL (the real
 * `parseNotebooklmNotebookTarget` + `buildNotebooklmNotebookUrl` run).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/open.js';

const NB = '17e2b882-1234-1234-1234-abcdef012345';
const NB_URL = `https://notebooklm.google.com/notebook/${NB}`;

describe('notebooklm open (marketplace)', () => {
  const command = findAdapter('notebooklm', 'open');
  let page = makeFakeNotebooklmPage();

  beforeEach(() => {
    page = makeFakeNotebooklmPage();
    page.setPageState({
      url: NB_URL,
      title: 'Browser Automation',
      hostname: 'notebooklm.google.com',
      kind: 'notebook',
      notebookId: NB,
      loginRequired: false,
      notebookCount: 1,
    });
    page.setCurrentNotebookRaw({
      id: NB,
      title: 'Browser Automation',
      url: NB_URL,
      source: 'current-page',
    });
  });

  it('opens a notebook by id in the adapter session', async () => {
    const result = await command!.func!(page, { notebook: NB });
    expect(page.goto).toHaveBeenCalledWith(NB_URL);
    expect(result).toEqual([
      {
        id: NB,
        title: 'Browser Automation',
        url: NB_URL,
        source: 'current-page',
        is_owner: true,
        created_at: null,
      },
    ]);
  });

  it('accepts a full notebook url', async () => {
    await command!.func!(page, { notebook: `${NB_URL}?pli=1` });
    expect(page.goto).toHaveBeenCalledWith(NB_URL);
  });
});
