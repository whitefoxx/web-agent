/**
 * Hand-ported from opencli/clis/xiaohongshu/feed.js.
 *
 * UPDATED: switched from XHR capture to DOM scraping.
 *
 * The upstream version and our initial port tried to capture the
 * `homefeed` XHR. But xhs.com SSR-renders the initial feed into the
 * page HTML — visiting /explore does NOT fire a homefeed request, the
 * notes are already in the DOM by the time navigation completes. This
 * version uses the same DOM-scraping strategy as search.js (which works
 * reliably), reading `section.note-item` cards directly.
 *
 * NOT byte-identical with opencli upstream.
 */

import { cli, Strategy } from '../../runtime/registry.js';
import { AuthRequiredError, EmptyResultError } from '../../runtime/errors.js';

const WAIT_FOR_CONTENT_JS = `
  new Promise((resolve) => {
    const detect = () => {
      if (document.querySelector('section.note-item')) return 'content';
      if (/登录后|请登录/.test(document.body?.innerText || '')) return 'login_wall';
      return null;
    };
    const found = detect();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const result = detect();
      if (result) { observer.disconnect(); resolve(result); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve('timeout'); }, 5000);
  })
`;

cli({
  site: 'xiaohongshu',
  name: 'feed',
  access: 'read',
  description: '小红书首页推荐 Feed (DOM scrape from /explore)',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  args: [{ name: 'limit', type: 'int', default: 20, help: 'Number of items to return' }],
  columns: ['rank', 'title', 'author', 'likes', 'url'],
  func: async (page, kwargs) => {
    const limit = Number(kwargs.limit ?? 20);

    await page.goto('https://www.xiaohongshu.com/explore');

    const waitResult = await page.evaluate(WAIT_FOR_CONTENT_JS);
    if (waitResult === 'login_wall') {
      throw new AuthRequiredError('www.xiaohongshu.com', 'Feed page requires login');
    }

    // Scroll once so any below-the-fold cards in the initial batch hydrate.
    await page.autoScroll({ times: 1 });

    const items = await page.evaluate(`
      (() => {
        const normalizeUrl = (href) => {
          if (!href) return '';
          if (href.startsWith('http://') || href.startsWith('https://')) return href;
          if (href.startsWith('/')) return 'https://www.xiaohongshu.com' + href;
          return '';
        };
        const cleanText = (v) => (v || '').replace(/\\s+/g, ' ').trim();

        const out = [];
        const seen = new Set();
        document.querySelectorAll('section.note-item').forEach((el) => {
          // Skip "related searches" / query promo rows
          if (el.classList.contains('query-note-item')) return;

          const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
          const nameEl = el.querySelector('a.author .name, .author-name, .nick-name, .name');
          const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
          const linkEl =
            el.querySelector('a.cover.mask') ||
            el.querySelector('a[href*="/explore/"]') ||
            el.querySelector('a[href*="/note/"]');
          const url = normalizeUrl(linkEl?.getAttribute('href') || '');
          if (!url || seen.has(url)) return;
          seen.add(url);

          out.push({
            title: cleanText(titleEl?.textContent || ''),
            author: cleanText(nameEl?.textContent || ''),
            likes: cleanText(likesEl?.textContent || '0'),
            url,
          });
        });
        return out;
      })()
    `);

    const data = Array.isArray(items) ? items : [];
    if (!data.length) {
      throw new EmptyResultError(
        'xiaohongshu/feed',
        'No note items found on /explore (selectors may need updating, or page failed to render)',
      );
    }
    return data.slice(0, limit).map((item, i) => ({
      rank: i + 1,
      title: item.title,
      author: item.author,
      likes: item.likes,
      url: item.url,
    }));
  },
});
