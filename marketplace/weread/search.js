// ../browser-agent/opencli/clis/weread/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CliError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/weread/utils.js

var WEREAD_DOMAIN = "weread.qq.com";
var WEREAD_WEB_ORIGIN = `https://${WEREAD_DOMAIN}`;
var WEREAD_SHELF_URL = `${WEREAD_WEB_ORIGIN}/web/shelf`;
var WEB_API = `${WEREAD_WEB_ORIGIN}/web`;
var API = `https://i.${WEREAD_DOMAIN}`;
var WEREAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function fetchWebApi(path, params) {
  const url = new URL(`${WEB_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": WEREAD_UA }
  });
  if (!resp.ok) {
    throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
  }
  try {
    return await resp.json();
  } catch {
    throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
  }
}

// ../browser-agent/opencli/clis/weread/search.js
function decodeNumericHtmlEntity(raw, radix) {
  const codePoint = parseInt(raw, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 1114111) {
    return null;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}
function decodeHtmlText(value) {
  return value.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-fA-F]+);/gi, (entity, n) => decodeNumericHtmlEntity(n, 16) ?? entity).replace(/&#(\d+);/g, (entity, n) => decodeNumericHtmlEntity(n, 10) ?? entity).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
function normalizeSearchTitle(value) {
  return value.replace(/\s+/g, " ").trim();
}
function buildSearchIdentity(title, author) {
  return `${normalizeSearchTitle(title)}\0${normalizeSearchTitle(author)}`;
}
function countSearchTitles(entries) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = normalizeSearchTitle(entry.title);
    if (!key)
      continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function countSearchIdentities(entries) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = buildSearchIdentity(entry.title, entry.author);
    if (!normalizeSearchTitle(entry.title) || !normalizeSearchTitle(entry.author))
      continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function isUniqueCount(counts, key) {
  return (counts.get(key) || 0) <= 1;
}
function buildSearchUrlQueues(entries) {
  const exactQueues = /* @__PURE__ */ new Map();
  const titleOnlyQueues = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const titleKey = normalizeSearchTitle(entry.title);
    if (!titleKey || !entry.url)
      continue;
    const queueMap = entry.author ? exactQueues : titleOnlyQueues;
    const queueKey = entry.author ? buildSearchIdentity(entry.title, entry.author) : titleKey;
    const current = queueMap.get(queueKey);
    if (current) {
      current.push(entry.url);
      continue;
    }
    queueMap.set(queueKey, [entry.url]);
  }
  return { exactQueues, titleOnlyQueues };
}
function resolveSearchResultUrl(params) {
  const { exactQueues, titleOnlyQueues, apiIdentityCounts, htmlIdentityCounts, apiTitleCounts, htmlTitleCounts, title, author } = params;
  const identityKey = buildSearchIdentity(title, author);
  if (isUniqueCount(apiIdentityCounts, identityKey) && isUniqueCount(htmlIdentityCounts, identityKey)) {
    const exactUrl = exactQueues.get(identityKey)?.shift();
    if (exactUrl)
      return exactUrl;
  }
  const titleKey = normalizeSearchTitle(title);
  if (!isUniqueCount(apiTitleCounts, titleKey) || !isUniqueCount(htmlTitleCounts, titleKey)) {
    return "";
  }
  return titleOnlyQueues.get(titleKey)?.shift() ?? "";
}
async function loadSearchHtmlEntries(query) {
  const url = new URL("/web/search/books", WEREAD_WEB_ORIGIN);
  url.searchParams.set("keyword", query);
  let resp;
  try {
    resp = await fetch(url.toString(), {
      headers: { "User-Agent": WEREAD_UA }
    });
  } catch (error) {
    throw new CommandExecutionError(`Failed to fetch WeRead search page: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resp.ok) {
    throw new CommandExecutionError(`WeRead search page request failed: HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
  return items.map((match) => {
    const chunk = match[1];
    const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
    const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
    const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
    const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
    const title = decodeHtmlText(titleMatch?.[1] || "");
    const author = decodeHtmlText(authorMatch?.[1] || "");
    return {
      author,
      url: href ? new URL(href, WEREAD_WEB_ORIGIN).toString() : "",
      title
    };
  }).filter((item) => item.url && item.title);
}
cli({
  site: "weread",
  name: "search",
  access: "read",
  description: "Search books on WeRead",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", positional: true, required: true, help: "Search keyword" },
    { name: "limit", type: "int", default: 10, help: "Max results" }
  ],
  columns: ["rank", "title", "author", "bookId", "url"],
  func: async (args) => {
    const [data, htmlEntries] = await Promise.all([
      fetchWebApi("/search/global", { keyword: args.query }),
      loadSearchHtmlEntries(String(args.query ?? ""))
    ]);
    const books = data?.books ?? [];
    if (!Array.isArray(books)) {
      throw new CommandExecutionError("WeRead search API returned an unreadable books payload");
    }
    if (books.length === 0) {
      throw new EmptyResultError("weread search", `No books were returned for query ${args.query}.`);
    }
    const { exactQueues, titleOnlyQueues } = buildSearchUrlQueues(htmlEntries);
    const apiIdentityCounts = countSearchIdentities(books.map((item) => ({
      title: item.bookInfo?.title ?? "",
      author: item.bookInfo?.author ?? ""
    })));
    const htmlIdentityCounts = countSearchIdentities(htmlEntries.filter((entry) => entry.author));
    const apiTitleCounts = countSearchTitles(books.map((item) => ({ title: item.bookInfo?.title ?? "" })));
    const htmlTitleCounts = countSearchTitles(htmlEntries);
    return books.slice(0, Number(args.limit)).map((item, i) => {
      const title = item.bookInfo?.title ?? "";
      const author = item.bookInfo?.author ?? "";
      return {
        rank: i + 1,
        title,
        author,
        bookId: item.bookInfo?.bookId ?? "",
        url: resolveSearchResultUrl({
          exactQueues,
          titleOnlyQueues,
          apiIdentityCounts,
          htmlIdentityCounts,
          apiTitleCounts,
          htmlTitleCounts,
          title,
          author
        })
      };
    });
  }
});
