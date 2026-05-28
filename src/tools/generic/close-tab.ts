import { cli } from '../../runtime/registry.js';
import { assertTabId } from './_helpers';

cli({
  site: 'generic',
  name: 'close_tab',
  access: 'read',
  description:
    '关闭一个标签页。多步抓取（open_url + scroll_page + get_text_from_tab）结束后用这个清理，避免给用户留一堆遗留 tab',
  args: [
    {
      name: 'tab_id',
      type: 'int',
      required: true,
      help: '要关闭的 tab id',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const tab = await assertTabId(kwargs.tab_id);
    await chrome.tabs.remove(tab.id!);
    return { tabId: tab.id, closed: true };
  },
});
