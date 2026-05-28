/**
 * Hand-ported from opencli/clis/xiaohongshu/notifications.js.
 *
 * UPDATED: switched from XHR capture (Pinia `notification.getNotification`)
 * to DOM scraping. The /notification page renders the list items in the
 * DOM after load, whether the data came from SSR or XHR — scraping is
 * timing-agnostic and matches the search.js/feed.js pattern.
 *
 * NOTE: selectors below are a best-effort starting point. If the page
 * layout changes or your account shows a different structure, inspect
 * the DOM (right-click → Inspect) and update the queries. The
 * EmptyResultError will tell you when scraping returned nothing.
 *
 * NOT byte-identical with opencli upstream.
 */

import { cli, Strategy } from '../../runtime/registry.js';
import { CliError, EmptyResultError } from '../../runtime/errors.js';

const SUPPORTED_TYPES = ['mentions'];

const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const SELECTORS = [
      '.message-list .item',
      '.notification-list .item',
      '.msg-item',
      '.message-item',
      'div[class*="message"] [class*="item"]',
    ];
    const detect = () => {
      for (const sel of SELECTORS) {
        if (document.querySelector(sel)) return 'content';
      }
      if (/登录后|请登录/.test(document.body?.innerText || '')) return 'login_wall';
      if (/暂无.*消息|暂无通知|没有.*消息/.test(document.body?.innerText || '')) return 'empty';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 6000);
  })
`;

cli({
  site: 'xiaohongshu',
  name: 'notifications',
  access: 'read',
  description: "小红书通知列表（v0 仅 mentions tab；DOM scrape from /notification）",
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  args: [
    {
      name: 'type',
      default: 'mentions',
      help: "Notification type: only 'mentions' supported in v0",
    },
    { name: 'limit', type: 'int', default: 20, help: 'Number of notifications to return' },
  ],
  columns: ['rank', 'user', 'action', 'content', 'note', 'time'],
  func: async (page, kwargs) => {
    const type = String(kwargs.type ?? 'mentions');
    const limit = Number(kwargs.limit ?? 20);

    if (!SUPPORTED_TYPES.includes(type)) {
      throw new CliError(
        'UNSUPPORTED',
        `Notification type '${type}' not yet supported in this port`,
        "Use type='mentions'. To support likes/connections, click the corresponding tab via page.evaluate before scraping.",
      );
    }

    await page.goto('https://www.xiaohongshu.com/notification');

    const waitResult = await page.evaluate(WAIT_FOR_CONTENT_JS);
    if (waitResult === 'login_wall') {
      throw new CliError('AUTH_REQUIRED', 'Notifications require login on xiaohongshu.com');
    }
    if (waitResult === 'empty') {
      return [];
    }

    // Give the rendered list a beat to fully hydrate
    await page.wait({ time: 1 });

    const items = await page.evaluate(`
      (() => {
        const cleanText = (v) => (v || '').replace(/\\s+/g, ' ').trim();
        const SELECTORS = [
          '.message-list .item',
          '.notification-list .item',
          '.msg-item',
          '.message-item',
        ];

        let listItems = [];
        for (const sel of SELECTORS) {
          const found = document.querySelectorAll(sel);
          if (found.length) { listItems = Array.from(found); break; }
        }

        return listItems.map((el) => {
          const userEl = el.querySelector('.user-name, .username, .name, .nickname');
          const actionEl = el.querySelector('.action, .title, .message-action, .action-text');
          const contentEl = el.querySelector('.content, .comment-content, .message-content, .text');
          const noteEl = el.querySelector('.note-content, .target, .target-content, .quote');
          const timeEl = el.querySelector('.time, .timestamp, .date, time');

          return {
            user: cleanText(userEl?.textContent || ''),
            action: cleanText(actionEl?.textContent || ''),
            content: cleanText(contentEl?.textContent || ''),
            note: cleanText(noteEl?.textContent || ''),
            time: cleanText(timeEl?.textContent || ''),
          };
        });
      })()
    `);

    const data = Array.isArray(items) ? items : [];
    if (!data.length) {
      throw new EmptyResultError(
        'xiaohongshu/notifications',
        'No notification items found on /notification. Selectors may need updating — inspect the DOM and adjust SELECTORS array in notifications.js.',
      );
    }

    return data.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      ...item,
    }));
  },
});
