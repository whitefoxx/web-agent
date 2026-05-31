// ../browser-agent/opencli/clis/bilibili/comments.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/bilibili/utils.js
import https from "node:https";

function resolveBvid(input) {
  const trimmed = String(input).trim();
  if (/^BV[A-Za-z0-9]+$/i.test(trimmed)) {
    return Promise.resolve(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    if (/(\.|^)bilibili\.com$/i.test(parsed.hostname)) {
      const match = parsed.pathname.match(/\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i);
      if (match) {
        return Promise.resolve(match[1]);
      }
    }
  } catch {
  }
  const shortCode = trimmed.replace(/^https?:\/\//, "").replace(/^(www\.)?b23\.tv\//, "");
  if (!/^[A-Za-z0-9]+$/.test(shortCode)) {
    return Promise.reject(new Error(`Cannot resolve BV ID from invalid b23.tv short code: ${trimmed}`));
  }
  const url = "https://b23.tv/" + shortCode;
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const location = res.headers.location;
      if (location) {
        const match = location.match(/\/video\/(BV[A-Za-z0-9]+)/);
        if (match) {
          res.resume();
          resolve(match[1]);
          return;
        }
      }
      res.resume();
      reject(new Error(`Cannot resolve BV ID from short URL: ${trimmed}`));
    });
    req.on("error", reject);
    req.setTimeout(4e3, () => {
      req.destroy();
      reject(new Error(`Timeout resolving short URL: ${trimmed}`));
    });
  });
}
var MIXIN_KEY_ENC_TAB = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];
async function getNavData(page) {
  return page.evaluate(`
    async () => {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
      return await res.json();
    }
  `);
}
async function getWbiKeys(page) {
  const nav = await getNavData(page);
  const wbiImg = nav?.data?.wbi_img ?? {};
  const imgUrl = wbiImg.img_url ?? "";
  const subUrl = wbiImg.sub_url ?? "";
  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";
  return { imgKey, subKey };
}
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || "").join("").slice(0, 32);
}
async function md5(text) {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(text).digest("hex");
}
async function wbiSign(page, params) {
  const { imgKey, subKey } = await getWbiKeys(page);
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1e3);
  const sorted = {};
  const allParams = { ...params, wts: String(wts) };
  for (const key of Object.keys(allParams).sort()) {
    sorted[key] = String(allParams[key]).replace(/[!'()*]/g, "");
  }
  const query = new URLSearchParams(sorted).toString().replace(/\+/g, "%20");
  const wRid = await md5(query + mixinKey);
  sorted.w_rid = wRid;
  return sorted;
}
async function apiGet(page, path, opts = {}) {
  const baseUrl = "https://api.bilibili.com";
  let params = opts.params ?? {};
  if (opts.signed) {
    params = await wbiSign(page, params);
  }
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))).toString().replace(/\+/g, "%20");
  const url = `${baseUrl}${path}?${qs}`;
  return fetchJson(page, url);
}
async function fetchJson(page, url) {
  const urlJs = JSON.stringify(url);
  return page.evaluate(`
    async () => {
      const res = await fetch(${urlJs}, { credentials: "include" });
      return await res.json();
    }
  `);
}

// ../browser-agent/opencli/clis/bilibili/comments.js
var MAX_LIMIT = 50;
function isAuthLikeBilibiliError(code, message) {
  return code === -101 || code === -403 || /登录|账号|权限|forbidden|permission|login/i.test(String(message ?? ""));
}
function parseLimit(value) {
  const raw = value == null ? 20 : value;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ArgumentError(`bilibili comments limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}
function parseParent(value) {
  if (value == null) {
    return null;
  }
  const parent = Number(value);
  if (!Number.isInteger(parent) || parent <= 0) {
    throw new ArgumentError("bilibili comments parent must be a positive integer rpid");
  }
  return parent;
}
function requireOkPayload(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "code")) {
    throw new CommandExecutionError(`Bilibili ${label} API returned a malformed payload`);
  }
  if (payload.code !== 0) {
    const message = payload.message ?? "unknown error";
    if (isAuthLikeBilibiliError(payload.code, message)) {
      throw new AuthRequiredError("bilibili.com", `Bilibili ${label} API requires login or permission: ${message} (${payload.code})`);
    }
    throw new CommandExecutionError(`Bilibili ${label} API failed: ${message} (${payload.code})`);
  }
  return payload.data;
}
function requireReplies(data, label) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CommandExecutionError(`Bilibili ${label} API returned malformed data`);
  }
  if (!Object.hasOwn(data, "replies")) {
    throw new CommandExecutionError(`Bilibili ${label} API did not return replies`);
  }
  if (data.replies === null) {
    return [];
  }
  if (!Array.isArray(data.replies)) {
    throw new CommandExecutionError(`Bilibili ${label} API returned malformed replies`);
  }
  return data.replies;
}
function formatReplyRow(reply, index) {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    throw new CommandExecutionError(`Bilibili comments reply ${index + 1} was malformed`);
  }
  const rpid = String(reply.rpid ?? "").trim();
  if (!rpid) {
    throw new CommandExecutionError(`Bilibili comments reply ${index + 1} was missing rpid`);
  }
  const ctime = Number(reply.ctime);
  if (!Number.isFinite(ctime)) {
    throw new CommandExecutionError(`Bilibili comments reply ${index + 1} was missing ctime`);
  }
  return {
    rank: index + 1,
    rpid,
    author: String(reply.member?.uname ?? ""),
    text: String(reply.content?.message ?? "").replace(/\n/g, " ").trim(),
    likes: reply.like ?? 0,
    replies: reply.rcount ?? 0,
    time: new Date(ctime * 1e3).toISOString().slice(0, 16).replace("T", " ")
  };
}
cli({
  site: "bilibili",
  name: "comments",
  access: "read",
  description: "获取 B站视频评论（官方 API；用 --parent <rpid> 读取某条评论下的「楼中楼」回复）",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "bvid", required: true, positional: true, help: "Video BV ID (e.g. BV1WtAGzYEBm)" },
    { name: "parent", type: "int", help: "rpid of a comment — fetch the replies under it instead of top-level comments" },
    { name: "limit", type: "int", default: 20, help: "Number of comments (max 50)" }
  ],
  columns: ["rank", "rpid", "author", "text", "likes", "replies", "time"],
  func: async (page, kwargs) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for bilibili comments");
    }
    let bvid;
    try {
      bvid = await resolveBvid(kwargs.bvid);
    } catch (error) {
      throw new ArgumentError(`Cannot resolve Bilibili BV ID from input: ${String(kwargs.bvid ?? "")}`, error instanceof Error ? error.message : String(error));
    }
    const limit = parseLimit(kwargs.limit);
    const parent = parseParent(kwargs.parent);
    const view = await apiGet(page, "/x/web-interface/view", { params: { bvid } });
    const viewData = requireOkPayload(view, "view");
    const aid = viewData?.aid;
    if (!aid)
      throw new CommandExecutionError(`Cannot resolve aid for bvid: ${bvid}`);
    const payload = parent != null ? await apiGet(page, "/x/v2/reply/reply", {
      params: { oid: aid, type: 1, root: parent, pn: 1, ps: limit }
    }) : await apiGet(page, "/x/v2/reply/main", {
      params: { oid: aid, type: 1, mode: 3, ps: limit },
      signed: true
    });
    const label = parent != null ? "reply thread" : "reply main";
    const replies = requireReplies(requireOkPayload(payload, label), label);
    if (replies.length === 0) {
      throw new EmptyResultError(parent != null ? `bilibili comment replies: ${parent}` : `bilibili comments: ${bvid}`);
    }
    return replies.slice(0, limit).map(formatReplyRow);
  }
});
