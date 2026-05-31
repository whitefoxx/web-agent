// ../browser-agent/opencli/clis/weread/shelf.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CliError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";

// ../browser-agent/opencli/clis/weread/utils.js

var WEREAD_DOMAIN = "weread.qq.com";
var WEREAD_WEB_ORIGIN = `https://${WEREAD_DOMAIN}`;
var WEREAD_SHELF_URL = `${WEREAD_WEB_ORIGIN}/web/shelf`;
var WEB_API = `${WEREAD_WEB_ORIGIN}/web`;
var API = `https://i.${WEREAD_DOMAIN}`;
var WEREAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var WEREAD_AUTH_ERRCODES = /* @__PURE__ */ new Set([-2010, -2012]);
function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
function isAuthErrorResponse(resp, data) {
  return resp.status === 401 || WEREAD_AUTH_ERRCODES.has(Number(data?.errcode));
}
function getCurrentVid(cookies) {
  return String(cookies.find((cookie) => cookie.name === "wr_vid")?.value || "").trim();
}
function getWebShelfStorageKeys(currentVid) {
  return {
    rawBooksKey: `shelf:rawBooks:${currentVid}`,
    shelfIndexesKey: `shelf:shelfIndexes:${currentVid}`
  };
}
function normalizeWebShelfSnapshot(value) {
  return {
    cacheFound: value?.cacheFound === true,
    rawBooks: Array.isArray(value?.rawBooks) ? value.rawBooks : [],
    shelfIndexes: Array.isArray(value?.shelfIndexes) ? value.shelfIndexes : []
  };
}
function buildShelfSnapshotPollScript(storageKeys, requireTrustedIndexes) {
  return `
    (() => new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const rawBooksKey = ${JSON.stringify(storageKeys.rawBooksKey)};
      const shelfIndexesKey = ${JSON.stringify(storageKeys.shelfIndexesKey)};
      const requireTrustedIndexes = ${JSON.stringify(requireTrustedIndexes)};

      const readJson = (raw) => {
        if (typeof raw !== 'string') return null;
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      };

      const collectBookIds = (items) => Array.isArray(items)
        ? Array.from(new Set(items.map((item) => String(item?.bookId || '').trim()).filter(Boolean)))
        : [];

      // Mirror of getTrustedIndexedBookIds in Node.js — keep in sync
      const hasTrustedIndexes = (rawBooks, shelfIndexes) => {
        const rawBookIds = collectBookIds(rawBooks);
        if (rawBookIds.length === 0) return false;

        const rawBookIdSet = new Set(rawBookIds);
        const projectedIndexedBookIds = Array.isArray(shelfIndexes)
          ? Array.from(new Set(
              shelfIndexes
                .filter((entry) => Number.isFinite(entry?.idx))
                .sort((left, right) => Number(left?.idx ?? Number.MAX_SAFE_INTEGER) - Number(right?.idx ?? Number.MAX_SAFE_INTEGER))
                .map((entry) => String(entry?.bookId || '').trim())
                .filter((bookId) => rawBookIdSet.has(bookId)),
            ))
          : [];

        return projectedIndexedBookIds.length === rawBookIds.length;
      };

      const poll = () => {
        const rawBooks = readJson(localStorage.getItem(rawBooksKey));
        const shelfIndexes = readJson(localStorage.getItem(shelfIndexesKey));
        const cacheFound = Array.isArray(rawBooks);
        const ready = cacheFound && (!requireTrustedIndexes || hasTrustedIndexes(rawBooks, shelfIndexes));

        if (ready || Date.now() >= deadline) {
          resolve({
            cacheFound,
            rawBooks: Array.isArray(rawBooks) ? rawBooks : [],
            shelfIndexes: Array.isArray(shelfIndexes) ? shelfIndexes : [],
          });
          return;
        }

        setTimeout(poll, 100);
      };

      poll();
    }))
  `;
}
async function fetchPrivateApi(page, path, params) {
  const url = new URL(`${API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, v);
  }
  const urlStr = url.toString();
  const [apiCookies, domainCookies] = await Promise.all([
    page.getCookies({ url: urlStr }),
    page.getCookies({ domain: WEREAD_DOMAIN })
  ]);
  const merged = /* @__PURE__ */ new Map();
  for (const c of domainCookies)
    merged.set(c.name, c);
  for (const c of apiCookies)
    merged.set(c.name, c);
  const cookieHeader = buildCookieHeader(Array.from(merged.values()));
  let resp;
  try {
    resp = await fetch(urlStr, {
      headers: {
        "User-Agent": WEREAD_UA,
        "Origin": "https://weread.qq.com",
        "Referer": "https://weread.qq.com/",
        ...cookieHeader ? { "Cookie": cookieHeader } : {}
      }
    });
  } catch (error) {
    throw new CliError("FETCH_ERROR", `Failed to fetch ${path}: ${error instanceof Error ? error.message : String(error)}`, "WeRead API may be temporarily unavailable");
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
  }
  if (isAuthErrorResponse(resp, data)) {
    throw new CliError("AUTH_REQUIRED", "Not logged in to WeRead", "Please log in to weread.qq.com in Chrome first");
  }
  if (!resp.ok) {
    throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
  }
  if (data?.errcode != null && data.errcode !== 0) {
    throw new CliError("API_ERROR", data.errmsg ?? `WeRead API error ${data.errcode}`);
  }
  return data;
}
function getUniqueRawBookIds(snapshot) {
  return Array.from(new Set(snapshot.rawBooks.map((book) => String(book?.bookId || "").trim()).filter(Boolean)));
}
function getTrustedIndexedBookIds(snapshot) {
  const rawBookIds = getUniqueRawBookIds(snapshot);
  if (rawBookIds.length === 0)
    return [];
  const rawBookIdSet = new Set(rawBookIds);
  const projectedIndexedBookIds = Array.from(new Set(snapshot.shelfIndexes.filter((entry) => Number.isFinite(entry?.idx)).sort((left, right) => Number(left?.idx ?? Number.MAX_SAFE_INTEGER) - Number(right?.idx ?? Number.MAX_SAFE_INTEGER)).map((entry) => String(entry?.bookId || "").trim()).filter((bookId) => rawBookIdSet.has(bookId))));
  return projectedIndexedBookIds.length === rawBookIds.length ? projectedIndexedBookIds : [];
}
function buildWebShelfEntries(snapshot, readerUrls = []) {
  const rawBookIds = getUniqueRawBookIds(snapshot);
  const trustedIndexedBookIds = getTrustedIndexedBookIds(snapshot);
  const orderedBookIds = trustedIndexedBookIds.length > 0 ? trustedIndexedBookIds : rawBookIds;
  const rawBookById = /* @__PURE__ */ new Map();
  for (const book of snapshot.rawBooks) {
    const bookId = String(book?.bookId || "").trim();
    if (!bookId || rawBookById.has(bookId))
      continue;
    rawBookById.set(bookId, book);
  }
  return orderedBookIds.map((bookId, index) => {
    const book = rawBookById.get(bookId);
    return {
      bookId,
      title: String(book?.title || "").trim(),
      author: String(book?.author || "").trim(),
      readerUrl: String(readerUrls[index] || "").trim()
    };
  });
}
async function loadWebShelfSnapshotWithVid(page) {
  await page.goto(WEREAD_SHELF_URL);
  const cookies = await page.getCookies({ domain: WEREAD_DOMAIN });
  const currentVid = getCurrentVid(cookies);
  if (!currentVid) {
    return { snapshot: { cacheFound: false, rawBooks: [], shelfIndexes: [] }, currentVid: "" };
  }
  const result = await page.evaluate(buildShelfSnapshotPollScript(getWebShelfStorageKeys(currentVid), false));
  return {
    snapshot: normalizeWebShelfSnapshot(result),
    currentVid
  };
}
async function loadWebShelfSnapshot(page) {
  const { snapshot } = await loadWebShelfSnapshotWithVid(page);
  return snapshot;
}

// ../browser-agent/opencli/clis/weread/shelf.js
function normalizeShelfLimit(limit) {
  if (!Number.isFinite(limit))
    return 0;
  return Math.max(0, Math.trunc(limit));
}
function normalizePrivateApiRows(data, limit) {
  const books = data?.books ?? [];
  return books.slice(0, limit).map((item) => ({
    title: item.bookInfo?.title ?? item.title ?? "",
    author: item.bookInfo?.author ?? item.author ?? "",
    // TODO: readingProgress field name from community docs, verify with real API response
    progress: item.readingProgress != null ? `${item.readingProgress}%` : "-",
    bookId: item.bookId ?? item.bookInfo?.bookId ?? ""
  }));
}
function normalizeWebShelfRows(snapshot, limit) {
  if (limit <= 0)
    return [];
  return buildWebShelfEntries(snapshot).map((entry) => ({
    title: entry.title,
    author: entry.author,
    progress: "-",
    bookId: entry.bookId
  })).filter((item) => Boolean(item.title || item.bookId)).slice(0, limit);
}
cli({
  site: "weread",
  name: "shelf",
  access: "read",
  description: "List books on your WeRead bookshelf",
  domain: "weread.qq.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "Max results" }
  ],
  columns: ["title", "author", "progress", "bookId"],
  func: async (page, args) => {
    const limit = normalizeShelfLimit(Number(args.limit));
    if (limit <= 0)
      return [];
    try {
      const data = await fetchPrivateApi(page, "/shelf/sync", { synckey: "0", lectureSynckey: "0" });
      return normalizePrivateApiRows(data, limit);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") {
        throw error;
      }
      const snapshot = await loadWebShelfSnapshot(page);
      if (!snapshot.cacheFound) {
        throw error;
      }
      log.warn("WeRead private API auth expired; showing cached shelf data from localStorage. Results may be stale, and detail commands may still require re-login.");
      return normalizeWebShelfRows(snapshot, limit);
    }
  }
});
