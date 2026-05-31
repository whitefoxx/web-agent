// ../browser-agent/opencli/clis/weread-official/book.js
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
function formatDuration(secs) {
  if (secs === null || secs === void 0 || secs === "") return "";
  const total = Number(secs);
  if (!Number.isFinite(total) || total < 0) return "";
  const seconds = Math.floor(total);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
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
function emptyResult(command, hint) {
  throw new EmptyResultError(`weread-official ${command}`, hint);
}

// ../browser-agent/opencli/clis/weread-official/book.js
cli({
  site: "weread-official",
  name: "book",
  access: "read",
  description: "Show WeRead book metadata, chapters, and reading progress",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "bookId", positional: true, required: true, help: "WeRead bookId (from `weread-official search`)" },
    { name: "no-chapters", type: "boolean", default: false, help: "Skip /book/chapterinfo call" },
    { name: "no-progress", type: "boolean", default: false, help: "Skip /book/getprogress call" }
  ],
  columns: ["section", "idx", "key", "value", "link"],
  func: async (args) => {
    const bookId = requireBookId(args.bookId);
    const tasks = [callGateway("/book/info", { bookId })];
    const want = {
      chapters: !args["no-chapters"],
      progress: !args["no-progress"]
    };
    if (want.chapters) tasks.push(callGateway("/book/chapterinfo", { bookId }));
    if (want.progress) tasks.push(callGateway("/book/getprogress", { bookId }));
    const results = await Promise.all(tasks);
    let cursor = 0;
    const info = results[cursor++];
    const chapters = want.chapters ? results[cursor++] : null;
    const progress = want.progress ? results[cursor++] : null;
    const rows = [];
    const infoPairs = [
      ["bookId", String(info?.bookId ?? bookId)],
      ["title", String(info?.title ?? "")],
      ["author", String(info?.author ?? "")],
      ["translator", String(info?.translator ?? "")],
      ["category", String(info?.category ?? "")],
      ["publisher", String(info?.publisher ?? "")],
      ["publishTime", String(info?.publishTime ?? "")],
      ["isbn", String(info?.isbn ?? "")],
      ["wordCount", String(info?.wordCount ?? "")],
      ["rating", formatRating(info?.newRating)],
      ["ratingCount", String(info?.newRatingCount ?? "")],
      ["intro", truncate(info?.intro, 400)],
      ["cover", String(info?.cover ?? "")]
    ];
    for (let i = 0; i < infoPairs.length; i += 1) {
      const [key, value] = infoPairs[i];
      rows.push({ section: "info", idx: i + 1, key, value, link: "" });
    }
    rows.push({
      section: "info",
      idx: infoPairs.length + 1,
      key: "link",
      value: "",
      link: makeDeepLink({ bookId })
    });
    if (chapters) {
      const list = Array.isArray(chapters?.chapters) ? chapters.chapters : [];
      list.forEach((ch, i) => {
        const chapterUid = String(ch?.chapterUid ?? "").trim();
        const level = Number(ch?.level ?? 1);
        const indent = "  ".repeat(Math.max(0, level - 1));
        const title = `${indent}${String(ch?.title ?? "")}`;
        const wordCount = Number(ch?.wordCount ?? 0);
        const paid = Number(ch?.paid ?? 0) === 1;
        const price = Number(ch?.price ?? 0);
        const meta = [`${wordCount}字`];
        if (price > 0) meta.push(paid ? "已购买" : `${price}元`);
        rows.push({
          section: "chapter",
          idx: Number(ch?.chapterIdx ?? i + 1),
          key: chapterUid,
          value: `${title}  (${meta.join(" · ")})`,
          link: chapterUid ? makeDeepLink({ bookId, chapterUid }) : ""
        });
      });
    }
    if (progress) {
      const p = progress?.book ?? {};
      const pct = Number(p?.progress ?? 0);
      const updateTime = formatDate(p?.updateTime);
      const finishTime = pct === 100 ? formatDate(p?.finishTime) : "";
      const cumulative = formatDuration(p?.recordReadingTime);
      const isStart = Number(p?.isStartReading ?? 0) === 1;
      const progressPairs = [
        ["progress", `${pct}%`],
        ["cumulative", cumulative],
        ["lastReadAt", updateTime],
        ["finishedAt", finishTime],
        ["isStartReading", isStart ? "true" : "false"],
        ["currentChapterUid", String(p?.chapterUid ?? "")]
      ];
      for (let i = 0; i < progressPairs.length; i += 1) {
        const [key, value] = progressPairs[i];
        rows.push({ section: "progress", idx: i + 1, key, value, link: "" });
      }
    }
    if (rows.length === 0) {
      emptyResult("book", `No data returned for bookId=${bookId}`);
    }
    return rows;
  }
});
