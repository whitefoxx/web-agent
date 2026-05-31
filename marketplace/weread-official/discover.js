// ../browser-agent/opencli/clis/weread-official/discover.js
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
function formatRating(rating) {
  const value = Number(rating);
  if (!Number.isFinite(value) || value <= 0) return "暂无";
  const percent = value / 10;
  if (percent >= 90) return `神作 ${Math.round(percent)}%`;
  if (percent >= 80) return `力荐 ${Math.round(percent)}%`;
  if (percent >= 70) return `好评 ${Math.round(percent)}%`;
  return `${percent.toFixed(1)}分`;
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

// ../browser-agent/opencli/clis/weread-official/discover.js
cli({
  site: "weread-official",
  name: "discover",
  access: "read",
  description: "Personalized or similar-book recommendations from WeRead",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "bookId", positional: true, help: "Anchor bookId for similar-book mode; omit for personalized recommendations" },
    { name: "count", type: "int", default: 12, help: "Page size (default 12)" },
    { name: "max-idx", type: "int", default: 0, help: "Pagination cursor (recommend: previous searchIdx; similar: previous idx)" },
    { name: "session-id", help: "Carry-forward sessionId for /book/similar paging" }
  ],
  columns: ["rank", "mode", "bookId", "title", "author", "rating", "readingCount", "category", "idx", "reason", "cover", "intro", "link"],
  func: async (args) => {
    const count = requirePositiveInt(args.count, "count", { defaultValue: 12, max: 50 });
    const maxIdx = Number(args["max-idx"] ?? 0);
    const rawBookId = args.bookId !== void 0 && args.bookId !== null && String(args.bookId).trim() !== "" ? requireBookId(args.bookId) : null;
    if (!rawBookId) {
      return runRecommend({ count, maxIdx });
    }
    return runSimilar({ bookId: rawBookId, count, maxIdx, sessionId: args["session-id"] });
  }
});
async function runRecommend({ count, maxIdx }) {
  const payload = await callGateway("/book/recommend", { count, maxIdx });
  const books = Array.isArray(payload?.books) ? payload.books : [];
  if (books.length === 0) {
    emptyResult("discover", "No personalized recommendations available.");
  }
  return books.map((entry, i) => {
    const bookId = String(entry?.bookId ?? "").trim();
    return {
      rank: i + 1,
      mode: "recommend",
      bookId,
      title: String(entry?.title ?? ""),
      author: String(entry?.author ?? ""),
      rating: formatRating(entry?.newRating),
      readingCount: Number(entry?.readingCount ?? 0),
      category: String(entry?.category ?? ""),
      idx: Number(entry?.searchIdx ?? 0),
      reason: String(entry?.reason ?? ""),
      cover: String(entry?.cover ?? ""),
      intro: truncate(entry?.intro, 200),
      link: bookId ? makeDeepLink({ bookId }) : ""
    };
  });
}
async function runSimilar({ bookId, count, maxIdx, sessionId }) {
  const params = { bookId, count, maxIdx };
  const sid = String(sessionId ?? "").trim();
  if (sid) params.sessionId = sid;
  const payload = await callGateway("/book/similar", params);
  const inner = payload?.booksimilar ?? payload;
  const books = Array.isArray(inner?.books) ? inner.books : [];
  if (books.length === 0) {
    emptyResult("discover", `No similar books for bookId=${bookId}.`);
  }
  return books.map((wrapper, i) => {
    const info = wrapper?.book?.bookInfo ?? wrapper?.bookInfo ?? {};
    const id = String(info?.bookId ?? "").trim();
    return {
      rank: i + 1,
      mode: "similar",
      bookId: id,
      title: String(info?.title ?? ""),
      author: String(info?.author ?? ""),
      rating: formatRating(info?.newRating),
      readingCount: Number(info?.readingCount ?? 0),
      category: String(info?.category ?? ""),
      idx: Number(wrapper?.idx ?? 0),
      reason: "",
      // /book/similar does not surface a recommendation reason
      cover: String(info?.cover ?? ""),
      intro: truncate(info?.intro, 200),
      link: id ? makeDeepLink({ bookId: id }) : ""
    };
  });
}
