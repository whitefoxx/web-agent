// ../browser-agent/opencli/clis/weread/book.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CliError } from "@jackwener/opencli/errors";
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
async function waitForTrustedWebShelfSnapshot(page, snapshot, currentVid) {
  if (!snapshot.cacheFound)
    return snapshot;
  if (getTrustedIndexedBookIds(snapshot).length > 0)
    return snapshot;
  if (!currentVid)
    return snapshot;
  const result = await page.evaluate(buildShelfSnapshotPollScript(getWebShelfStorageKeys(currentVid), true));
  return normalizeWebShelfSnapshot(result);
}
async function resolveShelfReader(page, bookId) {
  const { snapshot: initialSnapshot, currentVid } = await loadWebShelfSnapshotWithVid(page);
  const snapshot = await waitForTrustedWebShelfSnapshot(page, initialSnapshot, currentVid);
  if (!snapshot.cacheFound) {
    return { snapshot, readerUrl: null };
  }
  const rawBookIds = getUniqueRawBookIds(snapshot);
  const trustedIndexedBookIds = getTrustedIndexedBookIds(snapshot);
  const canUseRawOrderFallback = trustedIndexedBookIds.length === 0 && rawBookIds.length > 0 && snapshot.shelfIndexes.length === 0;
  if (trustedIndexedBookIds.length === 0 && !canUseRawOrderFallback) {
    return { snapshot, readerUrl: null };
  }
  const readerUrls = await page.evaluate(`
    (() => Array.from(document.querySelectorAll('a.shelfBook[href]'))
      .map((anchor) => {
        const href = anchor.getAttribute('href') || '';
        return href ? new URL(href, location.origin).toString() : '';
      })
      .filter(Boolean))
  `);
  const expectedEntryCount = trustedIndexedBookIds.length > 0 ? trustedIndexedBookIds.length : rawBookIds.length;
  if (readerUrls.length !== expectedEntryCount) {
    return { snapshot, readerUrl: null };
  }
  const entries = buildWebShelfEntries(snapshot, readerUrls);
  const entry = entries.find((candidate) => candidate.bookId === bookId);
  return {
    snapshot,
    readerUrl: entry?.readerUrl || null
  };
}

// ../browser-agent/opencli/clis/weread/book.js
function decodeHtmlText(value) {
  return value.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-fA-F]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
}
function normalizeSearchText(value) {
  return value.replace(/\s+/g, " ").trim();
}
function buildSearchIdentity(title, author) {
  return `${normalizeSearchText(title)}\0${normalizeSearchText(author)}`;
}
function countSearchTitles(entries) {
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const key = normalizeSearchText(entry.title);
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
    if (!normalizeSearchText(entry.title) || !normalizeSearchText(entry.author))
      continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function strictTitleFromWereadDocumentTitle(rawTitle) {
  const suffix = " - 微信读书";
  const normalized = String(rawTitle || "").trim();
  if (!normalized.endsWith(suffix))
    return "";
  const base = normalized.slice(0, -suffix.length).trim();
  return base.includes(" - ") ? "" : base;
}
function extractReaderFallbackMetadata(doc) {
  const text = (node) => node?.textContent?.trim() || "";
  const firstText = (...sels) => {
    for (const s of sels) {
      const v = text(doc.querySelector(s));
      if (v)
        return v;
    }
    return "";
  };
  const bodyText = doc.body?.innerText?.replace(/\s+/g, " ").trim() || "";
  const extractRating = () => {
    const match = bodyText.match(/微信读书推荐值\s*([0-9.]+%)/);
    return match ? match[1] : "";
  };
  const extractPublisher = () => {
    const direct = text(doc.querySelector(".introDialog_content_pub_line"));
    return direct.startsWith("出版社") ? direct.replace(/^出版社\s*/, "").trim() : "";
  };
  const extractIntro = () => {
    const selectors = [
      ".horizontalReaderCoverPage_content_bookInfo_intro",
      ".wr_flyleaf_page_bookIntro_content",
      ".introDialog_content_intro_para"
    ];
    for (const selector of selectors) {
      const value = text(doc.querySelector(selector));
      if (value)
        return value;
    }
    return "";
  };
  const categorySource = Array.from(doc.scripts || []).map((script) => script.textContent || "").find((scriptText) => scriptText.includes('"category"')) || "";
  const categoryMatch = categorySource.match(/"category"\s*:\s*"([^"]+)"/);
  const title = firstText(".horizontalReaderCoverPage_content_bookTitle", ".wr_flyleaf_page_bookInfo_bookTitle", ".outline_book_detail_header_title", ".readerTopBar_title_link") || strictTitleFromWereadDocumentTitle(doc.title || "");
  const author = firstText(".horizontalReaderCoverPage_content_author", ".wr_flyleaf_page_bookInfo_author", ".outline_book_detail_header_author");
  return {
    title,
    author,
    publisher: extractPublisher(),
    intro: extractIntro(),
    category: categoryMatch ? categoryMatch[1].trim() : "",
    rating: extractRating(),
    metadataReady: Boolean(title || author)
  };
}
async function resolveSearchReaderUrl(title, author) {
  const normalizedTitle = normalizeSearchText(title);
  const normalizedAuthor = normalizeSearchText(author);
  if (!normalizedTitle)
    return "";
  try {
    const [data, htmlEntries] = await Promise.all([
      fetchWebApi("/search/global", { keyword: normalizedTitle }),
      (async () => {
        const url = new URL("/web/search/books", WEREAD_WEB_ORIGIN);
        url.searchParams.set("keyword", normalizedTitle);
        const resp = await fetch(url.toString(), {
          headers: { "User-Agent": WEREAD_UA }
        });
        if (!resp.ok)
          return [];
        const html = await resp.text();
        const items = Array.from(html.matchAll(/<li[^>]*class="wr_bookList_item"[^>]*>([\s\S]*?)<\/li>/g));
        return items.map((match) => {
          const chunk = match[1];
          const hrefMatch = chunk.match(/<a[^>]*href="([^"]+)"[^>]*class="wr_bookList_item_link"[^>]*>|<a[^>]*class="wr_bookList_item_link"[^>]*href="([^"]+)"[^>]*>/);
          const titleMatch = chunk.match(/<p[^>]*class="wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
          const authorMatch = chunk.match(/<p[^>]*class="wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
          const href = hrefMatch?.[1] || hrefMatch?.[2] || "";
          return {
            title: decodeHtmlText(titleMatch?.[1] || ""),
            author: decodeHtmlText(authorMatch?.[1] || ""),
            url: href ? new URL(href, WEREAD_WEB_ORIGIN).toString() : ""
          };
        }).filter((entry) => entry.title && entry.url);
      })()
    ]);
    const books = Array.isArray(data?.books) ? data.books : [];
    const apiIdentityCounts = countSearchIdentities(books.map((item) => ({
      title: item.bookInfo?.title ?? "",
      author: item.bookInfo?.author ?? ""
    })));
    const htmlIdentityCounts = countSearchIdentities(htmlEntries.filter((entry) => entry.author));
    const identityKey = buildSearchIdentity(normalizedTitle, normalizedAuthor);
    if (normalizedAuthor && (apiIdentityCounts.get(identityKey) || 0) === 1 && (htmlIdentityCounts.get(identityKey) || 0) === 1) {
      const exactMatch = htmlEntries.find((entry) => buildSearchIdentity(entry.title, entry.author) === identityKey);
      if (exactMatch?.url)
        return exactMatch.url;
    }
    const sameTitleHtmlEntries = htmlEntries.filter((entry) => normalizeSearchText(entry.title) === normalizedTitle);
    if (normalizedAuthor && sameTitleHtmlEntries.some((entry) => normalizeSearchText(entry.author))) {
      return "";
    }
    const apiTitleCounts = countSearchTitles(books.map((item) => ({ title: item.bookInfo?.title ?? "" })));
    const htmlTitleCounts = countSearchTitles(htmlEntries);
    if ((apiTitleCounts.get(normalizedTitle) || 0) !== 1 || (htmlTitleCounts.get(normalizedTitle) || 0) !== 1) {
      return "";
    }
    return htmlEntries.find((entry) => normalizeSearchText(entry.title) === normalizedTitle)?.url || "";
  } catch {
    return "";
  }
}
async function loadReaderFallbackResult(page, readerUrl) {
  await page.goto(readerUrl);
  await page.wait({ selector: ".horizontalReaderCoverPage_content_bookTitle, .wr_flyleaf_page_bookInfo_bookTitle, .readerTopBar_title_link", timeout: 10 });
  const result = await page.evaluate(`
    (${extractReaderFallbackMetadata.toString()})(document)
  `);
  return {
    title: String(result?.title || "").trim(),
    author: String(result?.author || "").trim(),
    publisher: String(result?.publisher || "").trim(),
    intro: String(result?.intro || "").trim(),
    category: String(result?.category || "").trim(),
    rating: String(result?.rating || "").trim(),
    metadataReady: result?.metadataReady === true
  };
}
cli({
  site: "weread",
  name: "book",
  access: "read",
  description: "View book details on WeRead",
  domain: "weread.qq.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "book-id", positional: true, required: true, help: "Book ID from search or shelf results" }
  ],
  columns: ["title", "author", "publisher", "intro", "category", "rating"],
  func: async (page, args) => {
    const bookId = String(args["book-id"] || "").trim();
    try {
      const data = await fetchPrivateApi(page, "/book/info", { bookId });
      const rating = data.newRating ? `${(data.newRating / 10).toFixed(1)}%` : "-";
      return [{
        title: data.title ?? "",
        author: data.author ?? "",
        publisher: data.publisher ?? "",
        intro: data.intro ?? "",
        category: data.category ?? "",
        rating
      }];
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== "AUTH_REQUIRED") {
        throw error;
      }
      // Trampoline idempotency: page.goto is a no-op when already at the url,
      // and the func re-executes from the top after every navigate-reinject.
      // The fallback chains two distinct gotos (shelf -> /web/reader/), which
      // ping-pongs forever. If the replay already lands on the final reader
      // page, use the current URL as readerUrl and SKIP the shelf resolution
      // (it reads shelf DOM/localStorage that isn't available here anyway).
      // See adapter-hot-plug.md §10.21.
      let readerUrl;
      const currentUrl = await page.getCurrentUrl().catch(() => "");
      if (/\/web\/reader\//.test(currentUrl)) {
        readerUrl = currentUrl;
      } else {
        const { readerUrl: resolvedReaderUrl, snapshot } = await resolveShelfReader(page, bookId);
        readerUrl = resolvedReaderUrl;
        if (!readerUrl) {
          const cachedBook = snapshot.rawBooks.find((book) => String(book?.bookId || "").trim() === bookId);
          readerUrl = await resolveSearchReaderUrl(String(cachedBook?.title || ""), String(cachedBook?.author || ""));
        }
      }
      if (!readerUrl) {
        throw error;
      }
      const data = await loadReaderFallbackResult(page, readerUrl);
      if (!data.metadataReady || !data.title) {
        throw error;
      }
      return [{
        title: data.title,
        author: data.author,
        publisher: data.publisher,
        intro: data.intro,
        category: data.category,
        rating: data.rating
      }];
    }
  }
});
export {
  extractReaderFallbackMetadata,
  strictTitleFromWereadDocumentTitle
};
