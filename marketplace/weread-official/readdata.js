// ../browser-agent/opencli/clis/weread-official/readdata.js
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
function requireChoice(value, choices, label, defaultValue) {
  const text = String(value ?? defaultValue ?? "").trim();
  if (!choices.includes(text)) {
    throw new ArgumentError(`weread-official: ${label} must be one of: ${choices.join(", ")}`);
  }
  return text;
}
function emptyResult(command, hint) {
  throw new EmptyResultError(`weread-official ${command}`, hint);
}

// ../browser-agent/opencli/clis/weread-official/readdata.js
var MODE_CHOICES = ["weekly", "monthly", "annually", "overall"];
cli({
  site: "weread-official",
  name: "readdata",
  access: "read",
  description: "Reading statistics: time, streak, preferences, top books",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "mode", default: "monthly", choices: MODE_CHOICES, help: "Stat window: weekly / monthly / annually / overall" },
    { name: "base-time", type: "int", help: "Optional Unix timestamp inside the target period; default is current period" }
  ],
  columns: ["section", "idx", "key", "value", "detail"],
  func: async (args) => {
    const mode = requireChoice(args.mode, MODE_CHOICES, "mode", "monthly");
    const params = { mode };
    if (args["base-time"] !== void 0 && args["base-time"] !== null && args["base-time"] !== "") {
      params.baseTime = requirePositiveInt(args["base-time"], "base-time");
    }
    const payload = await callGateway("/readdata/detail", params);
    const rows = [];
    const totalReadTime = Number(payload?.totalReadTime ?? 0);
    const dayAverage = Number(payload?.dayAverageReadTime ?? 0);
    const readDays = Number(payload?.readDays ?? 0);
    const compareRaw = payload?.compare;
    const compare = Number.isFinite(Number(compareRaw)) ? Number(compareRaw) : null;
    const summary = [
      ["mode", mode, ""],
      ["baseTime", formatDate(payload?.baseTime), String(payload?.baseTime ?? "")],
      ["readDays", String(readDays), ""],
      ["totalReadTime", formatDuration(totalReadTime), `${totalReadTime}s`],
      ["dayAverageReadTime", formatDuration(dayAverage), `${dayAverage}s`],
      ["compareToPrev", compare === null ? "" : `${(compare * 100).toFixed(1)}%`, ""],
      ["readRate", payload?.readRate !== void 0 ? `${Number(payload.readRate).toFixed(1)}%` : "", ""],
      ["preferTimeWord", String(payload?.preferTimeWord ?? ""), ""],
      ["preferCategoryWord", String(payload?.preferCategoryWord ?? ""), ""]
    ];
    for (let i = 0; i < summary.length; i += 1) {
      const [key, value, detail] = summary[i];
      rows.push({ section: "summary", idx: i + 1, key, value, detail });
    }
    const longest = Array.isArray(payload?.readLongest) ? payload.readLongest : [];
    longest.forEach((entry, i) => {
      const book = entry?.book ?? {};
      const albumInfo = entry?.albumInfo ?? null;
      const title = albumInfo ? String(albumInfo?.name ?? "") : String(book?.title ?? "");
      const author = albumInfo ? String(albumInfo?.authorName ?? "") : String(book?.author ?? "");
      const tags = Array.isArray(entry?.tags) ? entry.tags.join(",") : "";
      const readTime = Number(entry?.readTime ?? 0);
      rows.push({
        section: "longest",
        idx: i + 1,
        key: title,
        value: formatDuration(readTime),
        detail: `${author}${tags ? `  [${tags}]` : ""}`
      });
    });
    const readStat = Array.isArray(payload?.readStat) ? payload.readStat : [];
    readStat.forEach((entry, i) => {
      rows.push({
        section: "readStat",
        idx: i + 1,
        key: String(entry?.stat ?? ""),
        value: String(entry?.counts ?? ""),
        detail: ""
      });
    });
    const preferCategory = Array.isArray(payload?.preferCategory) ? payload.preferCategory : [];
    preferCategory.forEach((entry, i) => {
      const seconds = Number(entry?.readingTime ?? 0);
      rows.push({
        section: "preferCategory",
        idx: i + 1,
        key: String(entry?.categoryTitle ?? ""),
        value: formatDuration(seconds),
        detail: `${Number(entry?.readingCount ?? 0)}本`
      });
    });
    const preferAuthor = Array.isArray(payload?.preferAuthor) ? payload.preferAuthor : [];
    preferAuthor.forEach((entry, i) => {
      rows.push({
        section: "preferAuthor",
        idx: i + 1,
        key: String(entry?.name ?? ""),
        // preferAuthor[].readTime is server-formatted ("5小时30分钟"), not seconds.
        value: String(entry?.readTime ?? ""),
        detail: `${Number(entry?.count ?? 0)}本`
      });
    });
    const preferPublisher = Array.isArray(payload?.preferPublisher) ? payload.preferPublisher : [];
    preferPublisher.forEach((entry, i) => {
      rows.push({
        section: "preferPublisher",
        idx: i + 1,
        key: String(entry?.name ?? ""),
        value: `${Number(entry?.count ?? 0)}本`,
        detail: ""
      });
    });
    const preferTime = Array.isArray(payload?.preferTime) ? payload.preferTime : [];
    if (preferTime.length === 24) {
      for (let i = 0; i < 24; i += 1) {
        const hour = (6 + i) % 24;
        const seconds = Number(preferTime[i] ?? 0);
        rows.push({
          section: "preferTime",
          idx: i + 1,
          key: `${String(hour).padStart(2, "0")}:00`,
          value: formatDuration(seconds),
          detail: `${seconds}s`
        });
      }
    }
    if (rows.length === 0) {
      emptyResult("readdata", `No reading data for mode=${mode}.`);
    }
    return rows;
  }
});
export {
  MODE_CHOICES
};
