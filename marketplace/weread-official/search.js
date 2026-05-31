// ../browser-agent/opencli/clis/weread-official/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/weread-official/utils.js

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

// ../browser-agent/opencli/clis/weread-official/search.js
var SEARCH_SCOPES = Object.freeze({
  all: 0,
  ebook: 10,
  webnovel: 16,
  audio: 14,
  author: 6,
  fulltext: 12,
  booklist: 13,
  mp: 2,
  article: 4
});
var SCOPE_LABEL = Object.freeze({
  0: "全部",
  10: "电子书",
  16: "网文小说",
  14: "微信听书",
  6: "作者",
  12: "全文",
  13: "书单",
  2: "公众号",
  4: "文章"
});
cli({
  site: "weread-official",
  name: "search",
  access: "read",
  description: "Search WeRead store via the official agent gateway",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "keyword", positional: true, required: true, help: "Search keyword" },
    { name: "scope", default: "ebook", choices: Object.keys(SEARCH_SCOPES), help: "Search type (all/ebook/webnovel/audio/author/fulltext/booklist/mp/article)" },
    { name: "count", type: "int", help: "Page size (gateway default 15 when omitted)" },
    { name: "max-idx", type: "int", default: 0, help: "Pagination offset, use searchIdx of last item from previous page" }
  ],
  columns: ["rank", "scope", "bookId", "title", "author", "rating", "readingCount", "category", "searchIdx", "cover", "intro", "link"],
  func: async (args) => {
    const keyword = requireText(args.keyword, "keyword");
    const scopeKey = String(args.scope ?? "ebook").trim();
    if (!Object.prototype.hasOwnProperty.call(SEARCH_SCOPES, scopeKey)) {
      throw new ArgumentError(
        `weread-official: scope must be one of: ${Object.keys(SEARCH_SCOPES).join(", ")}`
      );
    }
    const scope = SEARCH_SCOPES[scopeKey];
    const params = { keyword, scope, maxIdx: args["max-idx"] ?? 0 };
    if (args.count !== void 0 && args.count !== null && args.count !== "") {
      params.count = requirePositiveInt(args.count, "count", { max: 100 });
    }
    const payload = await callGateway("/store/search", params);
    const groups = Array.isArray(payload?.results) ? payload.results : [];
    if (groups.length === 0) {
      emptyResult("search", `No results for "${keyword}" (scope=${scopeKey}).`);
    }
    const rows = [];
    let rank = 0;
    for (const group of groups) {
      const groupScope = SCOPE_LABEL[Number(group?.scope)] ?? "";
      const books = Array.isArray(group?.books) ? group.books : [];
      for (const entry of books) {
        rank += 1;
        const info = entry?.bookInfo ?? {};
        const bookId = String(info.bookId ?? "").trim();
        rows.push({
          rank,
          scope: groupScope,
          bookId,
          title: String(info.title ?? ""),
          author: String(info.author ?? ""),
          rating: formatRating(entry?.newRating),
          readingCount: Number(entry?.readingCount ?? 0),
          category: String(info.category ?? ""),
          searchIdx: Number(entry?.searchIdx ?? 0),
          cover: String(info.cover ?? ""),
          intro: truncate(info.intro, 120),
          link: bookId ? makeDeepLink({ bookId }) : ""
        });
      }
    }
    if (rows.length === 0) {
      emptyResult("search", `No books found in results for "${keyword}" (scope=${scopeKey}).`);
    }
    return rows;
  }
});
export {
  SEARCH_SCOPES
};
