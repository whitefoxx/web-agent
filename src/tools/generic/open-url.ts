import { cli } from '../../runtime/registry.js';
import { assertHttpUrl } from './_helpers';
import { getActiveExploreSession } from '../../explore/session';

cli({
  site: 'generic',
  name: 'open_url',
  access: 'read',
  description: '在新标签页打开一个 URL（任何站点）。打开后标签页保留，不自动关闭',
  args: [
    {
      name: 'url',
      type: 'string',
      required: true,
      help: '要打开的完整 URL（必须以 http:// 或 https:// 开头）',
    },
    {
      name: 'active',
      type: 'bool',
      help: '是否切换到该标签页前台。默认 false（后台打开）',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const url = assertHttpUrl(kwargs.url);
    const active = !!kwargs.active;
    // During an explore session, navigate the dedicated explore tab instead of
    // spawning a new one, so the session-wide network capture stays on it and
    // the synthesized adapter targets a single, stable tab.
    const session = getActiveExploreSession();
    if (session) {
      await chrome.tabs.update(session.tabId, { url, ...(active ? { active: true } : {}) });
      return { tabId: session.tabId, url, active, explore: true };
    }
    const tab = await chrome.tabs.create({ url, active });
    return {
      tabId: typeof tab.id === 'number' ? tab.id : null,
      url: tab.url ?? url,
      active,
    };
  },
});
