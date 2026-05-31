// ../browser-agent/opencli/clis/douban/movie-hot.js
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
async function loadDoubanMovieHot(page, limit) {
  const safeLimit = clampLimit(limit);
  await page.goto("https://movie.douban.com/chart");
  await page.wait(4);
  await ensureDoubanReady(page);
  const data = await page.evaluate(`
    (() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const results = [];
      for (const el of Array.from(document.querySelectorAll('.item'))) {
        const titleEl = el.querySelector('.pl2 a');
        const title = normalize(titleEl?.textContent);
        let url = titleEl?.getAttribute('href') || '';
        if (!title || !url) continue;
        if (!url.startsWith('http')) url = 'https://movie.douban.com' + url;
        const id = url.match(/subject\\/(\\d+)/)?.[1] || '';

        const info = normalize(el.querySelector('.pl2 p')?.textContent);
        const yearMatch = info.match(/\\b(19|20)\\d{2}\\b/);
        const votesText = normalize(el.querySelector('.star .pl')?.textContent);
        const votes = parseInt(votesText.replace(/[^0-9]/g, ''), 10) || 0;

        results.push({
          rank: results.length + 1,
          id,
          title,
          rating: parseFloat(normalize(el.querySelector('.rating_nums')?.textContent)) || 0,
          votes,
          year: yearMatch?.[0] || '',
          url,
          cover: el.querySelector('img')?.getAttribute('src') || '',
        });
        if (results.length >= ${safeLimit}) break;
      }
      return results;
    })()
  `);
  const results = Array.isArray(data) ? data : [];
  if (!results.length) {
    throw new EmptyResultError("douban movie-hot", "No movie chart rows were parsed from movie.douban.com/chart.");
  }
  return results;
}

// ../browser-agent/opencli/clis/douban/movie-hot.js
cli({
  site: "douban",
  name: "movie-hot",
  access: "read",
  description: "豆瓣电影热门榜单",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "返回的电影数量" }
  ],
  columns: ["rank", "id", "title", "rating", "votes", "year", "url"],
  func: async (page, args) => loadDoubanMovieHot(page, Number(args.limit) || 20)
});
