/**
 * Port of opencli's clis/notebooklm/note-list.test.js.
 *
 * Opencli mocks `getNotebooklmPageState` / `requireNotebooklmSession` /
 * `listNotebooklmNotesFromPage`. Inlined here, so we feed a valid notebook
 * page-state and the raw `artifact-library-note` DOM rows; the real
 * `parseNotebooklmNoteListRawRows` then derives the studio-list row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/note-list.js';

describe('notebooklm note-list (marketplace)', () => {
  const command = findAdapter('notebooklm', 'note-list');
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

  it('lists notebook notes from the Studio panel', async () => {
    // Raw DOM row: title from `.artifact-title`, text is the full node text.
    // The parser strips the title prefix off `text` to derive `created_at`.
    page.setNoteListRaw([{ title: '新建笔记', text: '新建笔记 6 分钟前' }]);

    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        notebook_id: 'nb-demo',
        title: '新建笔记',
        created_at: '6 分钟前',
        url: 'https://notebooklm.google.com/notebook/nb-demo',
        source: 'studio-list',
      },
    ]);
  });
});
