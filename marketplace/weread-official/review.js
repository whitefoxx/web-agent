// ../browser-agent/opencli/clis/weread-official/review.js
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
function formatStar(star) {
  const value = Number(star);
  if (!Number.isFinite(value) || value <= 0) return "无评分";
  const count = Math.min(5, Math.floor(value / 20));
  if (count <= 0) return "无评分";
  return "⭐".repeat(count);
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

// ../browser-agent/opencli/clis/weread-official/review.js
var TYPE_ALIASES = Object.freeze({
  all: 0,
  recommend: 1,
  "thumbs-down": 2,
  newest: 3,
  neutral: 4
});
cli({
  site: "weread-official",
  name: "review",
  access: "read",
  description: "Browse public reviews of a WeRead book",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "bookId", positional: true, required: true, help: "WeRead bookId (from `weread-official search`)" },
    { name: "type", default: "all", choices: Object.keys(TYPE_ALIASES), help: "Review filter (all/recommend/thumbs-down/newest/neutral)" },
    { name: "count", type: "int", default: 20, help: "Page size (1-100, default 20)" },
    { name: "max-idx", type: "int", default: 0, help: "Pagination cursor — pass idx from last row of previous page" },
    { name: "synckey", type: "int", help: "Sync cursor returned by previous response" }
  ],
  columns: ["rank", "idx", "reviewId", "star", "starLabel", "author", "isFinish", "chapter", "content", "createTime", "link"],
  func: async (args) => {
    const bookId = requireBookId(args.bookId);
    const typeKey = String(args.type ?? "all").trim();
    if (!Object.prototype.hasOwnProperty.call(TYPE_ALIASES, typeKey)) {
      throw new ArgumentError(
        `weread-official: type must be one of: ${Object.keys(TYPE_ALIASES).join(", ")}`
      );
    }
    const reviewListType = TYPE_ALIASES[typeKey];
    const count = requirePositiveInt(args.count, "count", { defaultValue: 20, max: 100 });
    const params = { bookId, reviewListType, count, maxIdx: Number(args["max-idx"] ?? 0) };
    if (args.synckey !== void 0 && args.synckey !== null && args.synckey !== "") {
      params.synckey = requirePositiveInt(args.synckey, "synckey");
    }
    const payload = await callGateway("/review/list", params);
    const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
    if (reviews.length === 0) {
      emptyResult("review", `No public reviews for bookId=${bookId} (type=${typeKey}).`);
    }
    return reviews.map((wrapper, i) => {
      const reviewOuter = wrapper?.review ?? {};
      const rv = reviewOuter?.review ?? {};
      const author = rv?.author ?? {};
      const chapter = String(rv?.chapterName ?? "").trim();
      const reviewId = String(reviewOuter?.reviewId ?? rv?.reviewId ?? "").trim();
      return {
        rank: i + 1,
        idx: Number(wrapper?.idx ?? 0),
        reviewId,
        star: Number(rv?.star ?? 0),
        starLabel: formatStar(rv?.star),
        author: String(author?.name ?? ""),
        isFinish: Number(rv?.isFinish ?? 0) === 1,
        chapter,
        content: truncate(rv?.content, 300),
        createTime: formatDate(rv?.createTime),
        link: makeDeepLink({ bookId })
      };
    });
  }
});
export {
  TYPE_ALIASES
};
