// ../browser-agent/opencli/clis/douban/book-hot.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError as ArgumentError2, CliError, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/_shared/common.js
import { ArgumentError } from "@jackwener/opencli/errors";
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
      const blocked = href.includes('sec.douban.com') || /\u767B\u5F55\u8DF3\u8F6C/.test(title) || /\u5F02\u5E38\u8BF7\u6C42/.test(document.body?.innerText || '');
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
            publisher: infoParts.find((part) => /\u51FA\u7248\u793E|\u51FA\u7248\u516C\u53F8|Press/i.test(part)) || infoParts[2] || '',
            year: infoParts.find((part) => /\\d{4}(?:-\\d{1,2})?/.test(part))?.match(/\\d{4}/)?.[0] || '',
            price: infoParts.find((part) => /\u5143|USD|\\$|\uFFE5/.test(part)) || '',
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
  description: "\u8C46\u74E3\u56FE\u4E66\u70ED\u95E8\u699C\u5355",
  domain: "book.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "\u8FD4\u56DE\u7684\u56FE\u4E66\u6570\u91CF" }
  ],
  columns: ["rank", "title", "rating", "quote", "author", "publisher", "year", "url"],
  func: async (page, args) => loadDoubanBookHot(page, Number(args.limit) || 20)
});
