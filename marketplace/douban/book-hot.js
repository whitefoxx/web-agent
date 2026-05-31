// ../browser-agent/opencli/clis/douban/book-hot.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError, CliError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/_shared/common.js

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// ../browser-agent/opencli/clis/douban/utils.js
var clampLimit = (limit) => clamp(limit || 20, 1, 50);
async function ensureDoubanReady(page) {
  const state = await page.evaluate(`
    (() => {
      const title = (document.title || '').trim();
      const href = (location.href || '').trim();
      const blocked = href.includes('sec.douban.com') || /登录跳转/.test(title) || /异常请求/.test(document.body?.innerText || '');
      return { blocked, title, href };
    })()
  `);
  if (state?.blocked) {
    throw new CliError("AUTH_REQUIRED", "Douban requires a logged-in browser session before these commands can load data.", "Please sign in to douban.com in the browser that opencli reuses, then rerun the command.");
  }
}
async function loadDoubanBookHot(page, limit) {
  const safeLimit = clampLimit(limit);
  await page.goto("https://book.douban.com/chart");
  await page.wait(4);
  await ensureDoubanReady(page);
  const data = await page.evaluate(`
    (() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const books = [];
      for (const el of Array.from(document.querySelectorAll('.media.clearfix'))) {
        try {
          const titleEl = el.querySelector('h2 a[href*="/subject/"]');
          const title = normalize(titleEl?.textContent);
          let url = titleEl?.getAttribute('href') || '';
          if (!title || !url) continue;
          if (!url.startsWith('http')) url = 'https://book.douban.com' + url;

          const info = normalize(el.querySelector('.subject-abstract, .pl, .pub')?.textContent);
          const infoParts = info.split('/').map((part) => part.trim()).filter(Boolean);
          const ratingText = normalize(el.querySelector('.subject-rating .font-small, .rating_nums, .rating')?.textContent);
          const quote = Array.from(el.querySelectorAll('.subject-tags .tag'))
            .map((node) => normalize(node.textContent))
            .filter(Boolean)
            .join(' / ');

          books.push({
            rank: parseInt(normalize(el.querySelector('.green-num-box')?.textContent), 10) || books.length + 1,
            title,
            rating: parseFloat(ratingText) || 0,
            quote,
            author: infoParts[0] || '',
            publisher: infoParts.find((part) => /出版社|出版公司|Press/i.test(part)) || infoParts[2] || '',
            year: infoParts.find((part) => /\\d{4}(?:-\\d{1,2})?/.test(part))?.match(/\\d{4}/)?.[0] || '',
            price: infoParts.find((part) => /元|USD|\\$|￥/.test(part)) || '',
            url,
            cover: el.querySelector('img')?.getAttribute('src') || '',
          });
        } catch {}
      }
      return books.slice(0, ${safeLimit});
    })()
  `);
  return Array.isArray(data) ? data : [];
}

// ../browser-agent/opencli/clis/douban/book-hot.js
cli({
  site: "douban",
  name: "book-hot",
  access: "read",
  description: "豆瓣图书热门榜单",
  domain: "book.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "返回的图书数量" }
  ],
  columns: ["rank", "title", "rating", "quote", "author", "publisher", "year", "url"],
  func: async (page, args) => loadDoubanBookHot(page, Number(args.limit) || 20)
});
