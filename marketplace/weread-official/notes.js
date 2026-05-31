// ../browser-agent/opencli/clis/weread-official/notes.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/weread-official/utils.js
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError
} from "@jackwener/opencli/errors";
var WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
var WEREAD_DOMAIN = "weread.qq.com";
var SKILL_VERSION = "1.0.3";
var DEFAULT_TIMEOUT_MS = 3e4;
var AUTH_ERRCODES = /* @__PURE__ */ new Set([-2010, -2012]);
function getApiKey() {
  const key = String(process.env.WEREAD_API_KEY ?? "").trim();
  if (!key) {
    throw new AuthRequiredError(
      WEREAD_DOMAIN,
      "WEREAD_API_KEY is not set. Export it with `export WEREAD_API_KEY=<wrk-...>`."
    );
  }
  return key;
}
function buildGatewayBody(apiName, params = {}) {
  if (!apiName || typeof apiName !== "string") {
    throw new ArgumentError("weread-official: api_name is required");
  }
  const body = { api_name: apiName, skill_version: SKILL_VERSION };
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === void 0 || value === null || value === "") continue;
    body[key] = value;
  }
  return body;
}
async function callGateway(apiName, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = getApiKey();
  const body = buildGatewayBody(apiName, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(WEREAD_GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new TimeoutError(`weread-official ${apiName}`, Math.round(timeoutMs / 1e3));
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`weread-official ${apiName} request failed`, detail);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new CommandExecutionError(
      `weread-official ${apiName} HTTP ${response.status}`,
      "Check WeRead gateway availability and that WEREAD_API_KEY is still valid."
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`weread-official ${apiName} returned invalid JSON`, detail);
  }
  if (payload && typeof payload === "object" && payload.upgrade_info) {
    const info = payload.upgrade_info;
    const required = info?.required_version ?? info?.version ?? "unknown";
    const message = info?.message ?? "WeRead skill version is outdated";
    throw new CommandExecutionError(
      `WeRead skill 需升级: ${message}. Required skill_version=${required}, current=${SKILL_VERSION}`,
      "Pull the latest weread-skills.zip and bump SKILL_VERSION in clis/weread-official/utils.js."
    );
  }
  const errcode = Number(payload?.errcode ?? 0);
  if (errcode !== 0) {
    const errmsg = String(payload?.errmsg ?? "unknown error");
    if (AUTH_ERRCODES.has(errcode)) {
      throw new AuthRequiredError(
        WEREAD_DOMAIN,
        `WEREAD_API_KEY rejected (errcode=${errcode}, ${errmsg}). Regenerate the key and re-export it.`
      );
    }
    throw new CommandExecutionError(
      `weread-official ${apiName} returned errcode=${errcode}`,
      errmsg
    );
  }
  return payload;
}
function formatDate(ts) {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1e3);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function truncate(text, maxLen = 200) {
  const value = String(text ?? "");
  if (!value) return "";
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}
function makeDeepLink({ bookId, chapterUid = "", rangeStart = "", rangeEnd = "", userVid = "" } = {}) {
  const bid = String(bookId ?? "").trim();
  if (!bid) return "";
  const chapter = String(chapterUid ?? "").trim();
  const start = String(rangeStart ?? "").trim();
  const end = String(rangeEnd ?? "").trim();
  if (chapter && start && end) {
    const params = new URLSearchParams({ bookId: bid, chapterUid: chapter, rangeStart: start, rangeEnd: end });
    const vid = String(userVid ?? "").trim();
    if (vid) params.set("userVid", vid);
    return `weread://bestbookmark?${params.toString()}`;
  }
  if (chapter) return `weread://reading?bId=${bid}&chapterUid=${chapter}`;
  return `weread://reading?bId=${bid}`;
}
function parseRange(range) {
  const text = String(range ?? "").trim();
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) return { rangeStart: "", rangeEnd: "" };
  return { rangeStart: match[1], rangeEnd: match[2] };
}
function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new ArgumentError(`weread-official: ${label} cannot be empty`);
  return text;
}
function requireBookId(value, label = "bookId") {
  const text = requireText(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new ArgumentError(`weread-official: ${label} contains invalid characters`, "Pass a bookId from `weread-official search`.");
  }
  return text;
}
function requirePositiveInt(value, label, { defaultValue, max } = {}) {
  if (value === void 0 || value === null || value === "") {
    if (defaultValue === void 0) {
      throw new ArgumentError(`weread-official: ${label} is required`);
    }
    return defaultValue;
  }
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new ArgumentError(`weread-official: ${label} must be a positive integer`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ArgumentError(`weread-official: ${label} must be a positive integer`);
  }
  if (max !== void 0 && n > max) {
    throw new ArgumentError(`weread-official: ${label} must be <= ${max}`);
  }
  return n;
}
function emptyResult(command, hint) {
  throw new EmptyResultError(`weread-official ${command}`, hint);
}

// ../browser-agent/opencli/clis/weread-official/notes.js
cli({
  site: "weread-official",
  name: "notes",
  access: "read",
  description: "List notebooks overview or merged highlights+thoughts for a book",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "bookId", positional: true, help: "Limit to one book; omit for full notebook overview" },
    { name: "count", type: "int", default: 20, help: "Page size for the notebooks overview (1-100)" },
    { name: "last-sort", type: "int", help: "Cursor: pass previous page sort value to fetch the next page (/user/notebooks)" }
  ],
  columns: ["kind", "bookId", "title", "author", "chapter", "reviewCount", "noteCount", "bookmarkCount", "totalNotes", "progress", "finished", "sort", "range", "text", "thought", "star", "createTime", "link"],
  func: async (args) => {
    const rawBookId = args.bookId !== void 0 && args.bookId !== null && String(args.bookId).trim() !== "" ? requireBookId(args.bookId) : null;
    if (!rawBookId) {
      return listNotebooks(args);
    }
    return listBookNotes(rawBookId);
  }
});
async function listNotebooks(args) {
  const count = requirePositiveInt(args.count, "count", { defaultValue: 20, max: 100 });
  const params = { count };
  if (args["last-sort"] !== void 0 && args["last-sort"] !== null && args["last-sort"] !== "") {
    params.lastSort = requirePositiveInt(args["last-sort"], "last-sort");
  }
  const payload = await callGateway("/user/notebooks", params);
  const books = Array.isArray(payload?.books) ? payload.books : [];
  if (books.length === 0) {
    emptyResult("notes", "No notebooks found.");
  }
  return books.map((entry) => {
    const book = entry?.book ?? {};
    const bookId = String(entry?.bookId ?? book?.bookId ?? "").trim();
    const reviewCount = Number(entry?.reviewCount ?? 0);
    const noteCount = Number(entry?.noteCount ?? 0);
    const bookmarkCount = Number(entry?.bookmarkCount ?? 0);
    return {
      kind: "notebook",
      bookId,
      title: String(book?.title ?? ""),
      author: String(book?.author ?? ""),
      chapter: "",
      reviewCount,
      noteCount,
      bookmarkCount,
      totalNotes: reviewCount + noteCount + bookmarkCount,
      progress: String(entry?.readingProgress ?? ""),
      finished: Number(entry?.markedStatus ?? 0) === 1,
      sort: Number(entry?.sort ?? 0),
      range: "",
      text: "",
      thought: "",
      star: "",
      createTime: "",
      link: bookId ? makeDeepLink({ bookId }) : ""
    };
  });
}
async function listBookNotes(bookId) {
  const [bookmarksResp, reviewsResp] = await Promise.all([
    callGateway("/book/bookmarklist", { bookId }),
    callGateway("/review/list/mine", { bookid: bookId })
  ]);
  const chapterIndex = /* @__PURE__ */ new Map();
  const chapterList = Array.isArray(bookmarksResp?.chapters) ? bookmarksResp.chapters : [];
  for (const ch of chapterList) {
    const uid = String(ch?.chapterUid ?? "").trim();
    if (!uid) continue;
    chapterIndex.set(uid, String(ch?.title ?? ""));
  }
  const rows = [];
  const bookmarks = Array.isArray(bookmarksResp?.updated) ? bookmarksResp.updated : [];
  for (const bm of bookmarks) {
    const chapterUid = String(bm?.chapterUid ?? "").trim();
    const { rangeStart, rangeEnd } = parseRange(bm?.range);
    rows.push({
      kind: "highlight",
      bookId,
      title: "",
      author: "",
      chapter: chapterIndex.get(chapterUid) ?? "",
      reviewCount: 0,
      noteCount: 0,
      bookmarkCount: 0,
      totalNotes: 0,
      progress: "",
      finished: false,
      sort: 0,
      range: String(bm?.range ?? ""),
      text: truncate(bm?.markText, 400),
      thought: "",
      star: "",
      createTime: formatDate(bm?.createTime),
      link: rangeStart && rangeEnd && chapterUid ? makeDeepLink({ bookId, chapterUid, rangeStart, rangeEnd }) : chapterUid ? makeDeepLink({ bookId, chapterUid }) : makeDeepLink({ bookId })
    });
  }
  const reviews = Array.isArray(reviewsResp?.reviews) ? reviewsResp.reviews : [];
  for (const wrapper of reviews) {
    const rv = wrapper?.review ?? {};
    const chapterUid = String(rv?.chapterUid ?? "").trim();
    const star = Number(rv?.star ?? -1);
    rows.push({
      kind: "thought",
      bookId,
      title: "",
      author: "",
      chapter: String(rv?.chapterName ?? "") || (chapterIndex.get(chapterUid) ?? ""),
      reviewCount: 0,
      noteCount: 0,
      bookmarkCount: 0,
      totalNotes: 0,
      progress: "",
      finished: Number(rv?.isFinish ?? 0) === 1,
      sort: 0,
      range: String(rv?.range ?? ""),
      text: "",
      thought: truncate(rv?.content, 400),
      star: star >= 0 ? String(star) : "",
      createTime: formatDate(rv?.createTime),
      link: chapterUid ? makeDeepLink({ bookId, chapterUid }) : makeDeepLink({ bookId })
    });
  }
  if (rows.length === 0) {
    emptyResult("notes", `No highlights or thoughts saved for bookId=${bookId}.`);
  }
  return rows;
}
