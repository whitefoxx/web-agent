// ../browser-agent/opencli/clis/weread-official/shelf.js
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
function emptyResult(command, hint) {
  throw new EmptyResultError(`weread-official ${command}`, hint);
}

// ../browser-agent/opencli/clis/weread-official/shelf.js
cli({
  site: "weread-official",
  name: "shelf",
  access: "read",
  description: "Sync your WeRead shelf (books + albums + article bookmark entry) via the official gateway",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [],
  columns: ["kind", "id", "title", "author", "category", "secret", "isTop", "finished", "updateTime", "cover", "link"],
  func: async () => {
    const payload = await callGateway("/shelf/sync", {});
    const books = Array.isArray(payload?.books) ? payload.books : [];
    const albums = Array.isArray(payload?.albums) ? payload.albums : [];
    const mp = payload?.mp;
    const hasMp = Boolean(
      mp && typeof mp === "object" && (Array.isArray(mp) ? mp.length > 0 : Object.keys(mp).length > 0)
    );
    const rows = [];
    for (const b of books) {
      const bookId = String(b?.bookId ?? "").trim();
      rows.push({
        kind: "book",
        id: bookId,
        title: String(b?.title ?? ""),
        author: String(b?.author ?? ""),
        category: String(b?.category ?? ""),
        secret: Number(b?.secret ?? 0) === 1,
        isTop: Number(b?.isTop ?? 0) === 1,
        finished: Number(b?.finishReading ?? 0) === 1,
        updateTime: formatDate(b?.readUpdateTime ?? b?.updateTime),
        cover: String(b?.cover ?? ""),
        link: bookId ? makeDeepLink({ bookId }) : ""
      });
    }
    for (const a of albums) {
      const info = a?.albumInfo ?? {};
      const extra = a?.albumInfoExtra ?? {};
      const albumId = String(info?.albumId ?? "").trim();
      rows.push({
        kind: "album",
        id: albumId,
        title: String(info?.name ?? ""),
        author: String(info?.authorName ?? ""),
        category: "",
        secret: Number(extra?.secret ?? 0) === 1,
        isTop: Number(extra?.isTop ?? 0) === 1,
        finished: Number(info?.finish ?? 0) === 1,
        updateTime: formatDate(extra?.lectureReadUpdateTime ?? info?.updateTime),
        cover: String(info?.cover ?? ""),
        link: ""
      });
    }
    if (hasMp) {
      rows.push({
        kind: "mp",
        id: "",
        title: "文章收藏",
        author: "",
        category: "",
        secret: true,
        isTop: false,
        finished: false,
        updateTime: "",
        cover: "",
        link: ""
      });
    }
    if (rows.length === 0) {
      emptyResult("shelf", "Your WeRead shelf is empty.");
    }
    return rows;
  }
});
