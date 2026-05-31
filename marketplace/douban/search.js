// ../browser-agent/opencli/clis/douban/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError, CliError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/_shared/common.js

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// ../browser-agent/opencli/clis/douban/utils.js
var clampLimit = (limit) => clamp(limit || 20, 1, 50);
var DOUBAN_SEARCH_READY_SELECTOR = ".item-root .title-text, .item-root .title a, .result-list .result-item h3 a";
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
function isDetachedPageError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Detached while handling command|Debugger is not attached to the tab|Target closed|No tab with id/i.test(message);
}
async function withDetachedRetry(task, options = {}) {
  const attempts = Math.max(1, options.attempts || 2);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isDetachedPageError(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}
function buildDoubanSearchUrl(type, keyword) {
  const url = new URL(`https://search.douban.com/${encodeURIComponent(type)}/subject_search`);
  url.searchParams.set("search_text", String(keyword || ""));
  if (String(type || "").trim() === "book") {
    url.searchParams.set("cat", "1001");
  }
  return url.toString();
}
function inferDoubanSearchResultType(searchType, item = {}) {
  const fallbackType = String(searchType || "").trim() || "movie";
  if (fallbackType !== "movie") {
    return fallbackType;
  }
  const moreUrl = String(item.moreUrl || item.more_url || "").trim();
  const isTv = moreUrl.match(/is_tv:\s*['"]?([01])['"]?/)?.[1] || "";
  if (isTv === "1") {
    return "tvshow";
  }
  const labels = Array.isArray(item.labels) ? item.labels.map((label) => typeof label === "string" ? label.trim() : String(label?.text || "").trim()).filter(Boolean) : [];
  return labels.includes("剧集") ? "tvshow" : fallbackType;
}
async function searchDouban(page, type, keyword, limit) {
  const safeLimit = clampLimit(limit);
  const inferDoubanSearchResultTypeSource = inferDoubanSearchResultType.toString();
  const searchUrl = buildDoubanSearchUrl(type, keyword);
  const data = await withDetachedRetry(async () => {
    await page.goto(searchUrl, { waitUntil: "load", settleMs: 1500 });
    await ensureDoubanReady(page);
    await page.wait({ selector: DOUBAN_SEARCH_READY_SELECTOR, timeout: 8 }).catch(() => {
    });
    return page.evaluate(`
    (async () => {
      const type = ${JSON.stringify(type)};
      const inferDoubanSearchResultType = ${inferDoubanSearchResultTypeSource};
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const seen = new Set();
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rawItems = Array.isArray(window.__DATA__?.items) ? window.__DATA__.items : [];
      const rawItemsById = new Map(
        rawItems
          .map((item) => [String(item?.id || '').trim(), item])
          .filter(([id]) => id),
      );

      for (let i = 0; i < 20; i += 1) {
        if (document.querySelector('.item-root .title-text, .item-root .title a')) break;
        await sleep(300);
      }

      const items = Array.from(document.querySelectorAll('.item-root, .result-list .result-item'));

      const results = [];
      for (const el of items) {
        const titleEl = el.querySelector('.title-text, .title a, .title h3 a, h3 a, a[title]');
        const title = normalize(titleEl?.textContent) || normalize(titleEl?.getAttribute('title'));
        let url = titleEl?.getAttribute('href') || el.querySelector('a[href*="/subject/"]')?.getAttribute('href') || '';
        if (!title || !url) continue;
        if (!url.startsWith('http')) url = 'https://search.douban.com' + url;
        if (!url.includes('/subject/') || seen.has(url)) continue;
        seen.add(url);
        const id = url.match(/subject\\/(\\d+)/)?.[1] || '';
        const rawItem = rawItemsById.get(id) || {};
        const ratingText = normalize(el.querySelector('.rating_nums')?.textContent);
        const abstract = normalize(
          el.querySelector('.meta.abstract, .meta, .abstract, .subject-abstract, p')?.textContent,
        );
        results.push({
          rank: results.length + 1,
          id,
          type: inferDoubanSearchResultType(type, rawItem),
          title,
          rating: ratingText.includes('.') ? parseFloat(ratingText) : 0,
          abstract: abstract.slice(0, 100) + (abstract.length > 100 ? '...' : ''),
          url,
          cover: el.querySelector('img')?.getAttribute('src') || '',
        });
        if (results.length >= ${safeLimit}) break;
      }
      return results;
    })()
  `);
  });
  return Array.isArray(data) ? data : [];
}

// ../browser-agent/opencli/clis/douban/search.js
cli({
  site: "douban",
  name: "search",
  access: "read",
  description: "搜索豆瓣电影、图书或音乐",
  domain: "search.douban.com",
  strategy: Strategy.COOKIE,
  navigateBefore: false,
  args: [
    { name: "type", default: "movie", choices: ["movie", "book", "music"], help: "搜索类型（movie=电影, book=图书, music=音乐）" },
    { name: "keyword", required: true, positional: true, help: "搜索关键词" },
    { name: "limit", type: "int", default: 20, help: "返回结果数量" }
  ],
  columns: ["rank", "title", "rating", "abstract", "url"],
  func: async (page, args) => searchDouban(page, args.type, args.keyword, Number(args.limit) || 20)
});
