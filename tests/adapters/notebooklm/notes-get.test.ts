/**
 * Port of opencli's clis/notebooklm/notes-get.test.js.
 *
 * Opencli mocks `readNotebooklmVisibleNoteFromPage` / `listNotebooklmNotesFromPage`
 * / `getNotebooklmPageState` / `requireNotebooklmSession`. Inlined here, so we
 * feed the raw visible-note editor payload and (for the fallback) the raw
 * studio-list DOM rows. The real `parseNotebooklmVisibleNoteRawRow` runs, so its
 * output carries the bundled `id: null` field (opencli mocked the parser's
 * output and never exercised it — a faithful mechanism difference, not a bug).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { makeFakeNotebooklmPage } from '../_helpers/notebooklm-page.js';

import '../../../marketplace/notebooklm/notes-get.js';

describe('notebooklm notes-get (marketplace)', () => {
  const command = findAdapter('notebooklm', 'notes-get');
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

  it('returns the currently visible note editor content when the title matches', async () => {
    page.setVisibleNoteRaw({ title: '新建笔记', content: '第一段\n第二段' });

    const result = await command!.func!(page, { note: '新建笔记' });
    expect(result).toEqual([
      {
        notebook_id: 'nb-demo',
        id: null,
        title: '新建笔记',
        content: '第一段\n第二段',
        url: 'https://notebooklm.google.com/notebook/nb-demo',
        source: 'studio-editor',
      },
    ]);
  });

  it('explains the current visible-note limitation when the target note is listed but not open', async () => {
    page.setVisibleNoteRaw(null);
    page.setNoteListRaw([{ title: '新建笔记', text: '新建笔记 6 分钟前' }]);

    await expect(command!.func!(page, { note: '新建笔记' })).rejects.toMatchObject({
      message: expect.stringMatching(/currently reads note content only from the visible note editor/i),
    });
  });
});
