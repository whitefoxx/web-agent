// ../browser-agent/opencli/clis/douban/subject.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError, CliError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/_shared/common.js

// ../browser-agent/opencli/clis/douban/utils.js
var normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized)
      return normalized;
  }
  return "";
}
function splitDoubanPeople(value) {
  return normalizeText(value).split(/\s*\/\s*/).map((entry) => normalizeText(entry)).filter(Boolean);
}
function parseDoubanBookInfoText(infoText) {
  const lines = String(infoText || "").replace(/\r/g, "\n").split("\n").map((line) => normalizeText(line)).filter(Boolean);
  const map = {};
  for (const line of lines) {
    const match = line.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
    if (!match)
      continue;
    const label = normalizeText(match[1]);
    const value = normalizeText(match[2]);
    if (!label)
      continue;
    map[label] = value;
  }
  return map;
}
function parseDoubanRating(value) {
  const normalized = normalizeText(value);
  if (!normalized)
    return 0;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
function parseDoubanCount(value) {
  const normalized = normalizeText(value).replace(/[^\d]/g, "");
  if (!normalized)
    return 0;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
function parseDoubanPageCount(value) {
  const match = normalizeText(value).match(/(\d+)/);
  if (!match)
    return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function extractDoubanPublishYear(value) {
  const match = normalizeText(value).match(/\b(19|20)\d{2}\b/);
  return match?.[0] || "";
}
function splitDoubanTitle(fullTitle) {
  const normalized = normalizeText(fullTitle);
  if (!normalized)
    return { title: "", originalTitle: "" };
  const match = normalized.match(/^([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+(?:\s*[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef·：:！？]+)*)\s+(.+)$/);
  if (!match) {
    return { title: normalized, originalTitle: "" };
  }
  return {
    title: normalizeText(match[1]),
    originalTitle: normalizeText(match[2])
  };
}
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
function normalizeDoubanSubjectId(subjectId) {
  const normalized = String(subjectId || "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ArgumentError(`Invalid Douban subject ID: ${subjectId}`);
  }
  return normalized;
}
function normalizeDoubanBookSubject(raw) {
  const info = parseDoubanBookInfoText(raw?.infoText);
  const title = firstNonEmpty([raw?.title]);
  const subtitle = firstNonEmpty([raw?.subtitle, info["副标题"]]);
  const originalTitle = firstNonEmpty([raw?.originalTitle, info["原作名"]]);
  const authors = splitDoubanPeople(firstNonEmpty([info["作者"]]));
  const translators = splitDoubanPeople(firstNonEmpty([info["译者"]]));
  const publisher = firstNonEmpty([info["出版社"], info["出品方"]]);
  const publishDate = firstNonEmpty([info["出版年"]]);
  const publishYear = extractDoubanPublishYear(publishDate);
  const pageCount = parseDoubanPageCount(info["页数"]);
  const binding = firstNonEmpty([info["装帧"]]);
  const price = firstNonEmpty([info["定价"]]);
  const series = firstNonEmpty([info["丛书"]]);
  const isbnRaw = firstNonEmpty([info["ISBN"]]).replace(/[^\dxX]/g, "");
  const isbn10 = isbnRaw.length === 10 ? isbnRaw : "";
  const isbn13 = isbnRaw.length === 13 ? isbnRaw : "";
  return {
    id: normalizeDoubanSubjectId(raw?.id),
    type: "book",
    title,
    subtitle,
    originalTitle,
    authors,
    translators,
    publisher,
    publishDate,
    publishYear,
    pageCount,
    binding,
    price,
    series,
    isbn10,
    isbn13,
    rating: parseDoubanRating(raw?.rating),
    ratingCount: parseDoubanCount(raw?.ratingCount),
    summary: normalizeText(raw?.summary),
    cover: firstNonEmpty([raw?.cover]),
    url: firstNonEmpty([raw?.url])
  };
}
async function loadDoubanMovieSubject(page, subjectId) {
  const normalizedId = normalizeDoubanSubjectId(subjectId);
  const data = await withDetachedRetry(async () => {
    await page.goto(`https://movie.douban.com/subject/${normalizedId}/`, { waitUntil: "load", settleMs: 1500 });
    await ensureDoubanReady(page);
    await page.wait({ selector: 'span[property="v:itemreviewed"], #info', timeout: 8 }).catch(() => {
    });
    return page.evaluate(`
    (() => {
      const id = ${JSON.stringify(normalizedId)};
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const { title, originalTitle } = (${splitDoubanTitle.toString()})(normalize(document.querySelector('span[property="v:itemreviewed"]')?.textContent || ''));
      const year = normalize(document.querySelector('.year')?.textContent).replace(/[()（）]/g, '');
      const rating = parseFloat(normalize(document.querySelector('strong[property="v:average"]')?.textContent || '0')) || 0;
      const ratingCount = parseInt(normalize(document.querySelector('span[property="v:votes"]')?.textContent || '0'), 10) || 0;
      const genres = Array.from(document.querySelectorAll('span[property="v:genre"]'))
        .map((node) => normalize(node.textContent))
        .filter(Boolean)
        .join(',');
      const directors = Array.from(document.querySelectorAll('a[rel="v:directedBy"]'))
        .map((node) => normalize(node.textContent))
        .filter(Boolean)
        .join(',');
      const casts = Array.from(document.querySelectorAll('a[rel="v:starring"]'))
        .slice(0, 5)
        .map((node) => normalize(node.textContent))
        .filter(Boolean);
      const infoText = document.querySelector('#info')?.textContent || '';
      let country = [];
      const countryMatch = infoText.match(/制片国家\\/地区:\\s*([^\\n]+)/);
      if (countryMatch) {
        country = countryMatch[1].trim().split(/\\s*\\/\\s*/).filter(Boolean);
      }
      const durationRaw = normalize(document.querySelector('span[property="v:runtime"]')?.textContent || '');
      const durationMatch = durationRaw.match(/(\\d+)/);
      const summary = normalize(document.querySelector('span[property="v:summary"]')?.textContent || '');
      return {
        id,
        type: 'movie',
        title,
        originalTitle,
        year,
        rating,
        ratingCount,
        genres,
        directors,
        casts,
        country,
        duration: durationMatch ? parseInt(durationMatch[1], 10) : null,
        summary: summary.slice(0, 200),
        url: 'https://movie.douban.com/subject/' + id + '/',
      };
    })()
  `);
  });
  return data;
}
async function loadDoubanBookSubject(page, subjectId) {
  const normalizedId = normalizeDoubanSubjectId(subjectId);
  const data = await withDetachedRetry(async () => {
    await page.goto(`https://book.douban.com/subject/${normalizedId}/`, { waitUntil: "load", settleMs: 1500 });
    await ensureDoubanReady(page);
    await page.wait({ selector: "h1 span, #info", timeout: 8 }).catch(() => {
    });
    return page.evaluate(`
    (() => {
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const pickSummary = () => {
        const nodes = Array.from(document.querySelectorAll('#link-report .intro, .related_info .intro'));
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const text = normalize(nodes[i]?.textContent);
          if (text) return text;
        }
        return '';
      };
      return {
        id: ${JSON.stringify(normalizedId)},
        title: normalize(document.querySelector('h1 span')?.textContent || document.querySelector('h1')?.textContent || ''),
        subtitle: '',
        originalTitle: '',
        infoText: document.querySelector('#info')?.innerText || document.querySelector('#info')?.textContent || '',
        rating: normalize(document.querySelector('strong.rating_num, strong[property="v:average"]')?.textContent || ''),
        ratingCount: normalize(document.querySelector('a.rating_people > span, span[property="v:votes"]')?.textContent || ''),
        summary: pickSummary(),
        cover: document.querySelector('#mainpic img')?.getAttribute('src') || '',
        url: location.href,
      };
    })()
  `);
  });
  return normalizeDoubanBookSubject(data);
}
async function loadDoubanSubjectDetail(page, subjectId, subjectType = "movie") {
  const type = String(subjectType || "movie").trim() === "book" ? "book" : "movie";
  if (type === "book") {
    return loadDoubanBookSubject(page, subjectId);
  }
  return loadDoubanMovieSubject(page, subjectId);
}

// ../browser-agent/opencli/clis/douban/subject.js
cli({
  site: "douban",
  name: "subject",
  access: "read",
  description: "获取豆瓣条目详情",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "id", required: true, positional: true, help: "豆瓣条目 ID" },
    { name: "type", default: "movie", choices: ["movie", "book"], help: "条目类型（movie=电影, book=图书）" }
  ],
  columns: [
    "id",
    "type",
    "title",
    "subtitle",
    "originalTitle",
    "authors",
    "translators",
    "publisher",
    "publishDate",
    "publishYear",
    "pageCount",
    "binding",
    "price",
    "series",
    "isbn10",
    "isbn13",
    "year",
    "rating",
    "ratingCount",
    "genres",
    "directors",
    "casts",
    "country",
    "duration",
    "summary",
    "url"
  ],
  func: async (page, args) => [await loadDoubanSubjectDetail(page, args.id, args.type)]
});
