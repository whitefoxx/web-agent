// ../browser-agent/opencli/clis/bilibili/summary.js
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

// ../browser-agent/opencli/clis/bilibili/summary.js
var BILIBILI_HOST_RE = /(^|\.)bilibili\.com$/i;
var B23_HOST_RE = /(^|\.)b23\.tv$/i;
var BVID_RE = /^BV[A-Za-z0-9]+$/;
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
async function readBvid(raw) {
  const input = String(raw ?? "").trim();
  if (!input) {
    throw new ArgumentError("bilibili summary bvid cannot be empty", "Pass a BV ID, Bilibili video URL, or b23.tv short link.");
  }
  if (BVID_RE.test(input)) {
    return input;
  }
  let parsed = null;
  try {
    parsed = new URL(input);
  } catch {
  }
  if (parsed) {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ArgumentError("Bilibili summary URL must use http or https");
    }
    if (BILIBILI_HOST_RE.test(parsed.hostname)) {
      const match = parsed.pathname.match(/\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i);
      if (!match) {
        throw new ArgumentError("Bilibili summary URL must contain a BV video id");
      }
      return match[1];
    }
    if (!B23_HOST_RE.test(parsed.hostname)) {
      throw new ArgumentError("Bilibili summary URL must be a bilibili.com or b23.tv URL");
    }
  }
  try {
    return await resolveBvid(input);
  } catch (error) {
    throw new ArgumentError(`Cannot resolve Bilibili BV ID from input: ${input}`, error instanceof Error ? error.message : String(error));
  }
}
function requireOkPayload(payload, label) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CommandExecutionError(`Bilibili ${label} API returned a malformed payload`);
  }
  if (payload.code !== 0) {
    const message = payload.message ?? "unknown error";
    if (payload.code === -101 || payload.code === -403 || /登录|权限|forbidden|permission|login/i.test(String(message))) {
      throw new AuthRequiredError("bilibili.com", `Bilibili ${label} API requires login or permission: ${message} (${payload.code})`);
    }
    throw new CommandExecutionError(`Bilibili ${label} API failed: ${message} (${payload.code})`);
  }
  return payload.data;
}
function readModelResult(data, bvid) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CommandExecutionError("Bilibili conclusion API returned malformed data");
  }
  if (data.code !== 0) {
    throw new EmptyResultError("bilibili summary", `Bilibili has not generated an AI summary for ${bvid}.`);
  }
  let modelResult = data.model_result;
  if (typeof modelResult === "string") {
    try {
      modelResult = JSON.parse(modelResult);
    } catch {
      throw new CommandExecutionError("Bilibili conclusion API returned malformed model_result JSON");
    }
  }
  if (!modelResult || typeof modelResult !== "object" || Array.isArray(modelResult)) {
    throw new CommandExecutionError("Bilibili conclusion API returned malformed model_result");
  }
  const summary = String(modelResult.summary ?? "").trim();
  if (!summary) {
    throw new EmptyResultError("bilibili summary", `Bilibili has not generated an AI summary for ${bvid}.`);
  }
  const outline = modelResult.outline ?? [];
  if (!Array.isArray(outline)) {
    throw new CommandExecutionError("Bilibili conclusion API returned malformed outline");
  }
  return { summary, outline };
}
function rowsFromModel(model) {
  const rows = [{ time: "", content: model.summary }];
  for (const section of model.outline) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new CommandExecutionError("Bilibili conclusion API returned malformed outline section");
    }
    const sectionTitle = String(section.title ?? "").trim();
    const sectionTime = formatTime(section.timestamp);
    if (sectionTitle) {
      rows.push({ time: sectionTime, content: `# ${sectionTitle}` });
    }
    const points = section.part_outline ?? [];
    if (!Array.isArray(points)) {
      throw new CommandExecutionError("Bilibili conclusion API returned malformed part outline");
    }
    for (const point of points) {
      if (!point || typeof point !== "object" || Array.isArray(point)) {
        throw new CommandExecutionError("Bilibili conclusion API returned malformed outline point");
      }
      const content = String(point.content ?? "").trim();
      if (content) {
        rows.push({ time: formatTime(point.timestamp), content });
      }
    }
  }
  return rows;
}
var command = cli({
  site: "bilibili",
  name: "summary",
  access: "read",
  description: "获取 B站视频的官方 AI 总结（视频页「AI总结」同款，含分段大纲与时间戳）",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "bvid", required: true, positional: true, help: "Video BV ID / URL / b23.tv short link" }
  ],
  columns: ["time", "content"],
  func: async (page, kwargs) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for bilibili summary");
    }
    const bvid = await readBvid(kwargs.bvid);
    const view = await apiGet(page, "/x/web-interface/view", { params: { bvid } });
    const viewData = requireOkPayload(view, "view");
    const cid = viewData?.cid;
    const upMid = viewData?.owner?.mid;
    if (!cid || !upMid) {
      throw new CommandExecutionError(`Bilibili view API did not return cid/up_mid for ${bvid}`);
    }
    const conclusion = await apiGet(page, "/x/web-interface/view/conclusion/get", {
      params: { bvid, cid, up_mid: upMid },
      signed: true
    });
    const conclusionData = requireOkPayload(conclusion, "conclusion");
    return rowsFromModel(readModelResult(conclusionData, bvid));
  }
});
var __test__ = {
  command,
  formatTime,
  readBvid,
  readModelResult,
  rowsFromModel
};
export {
  __test__
};
