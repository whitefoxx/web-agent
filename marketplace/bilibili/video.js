// ../browser-agent/opencli/clis/bilibili/video.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
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

// ../browser-agent/opencli/clis/bilibili/video.js
cli({
  site: "bilibili",
  name: "video",
  access: "read",
  description: "Get Bilibili video metadata (title, author, duration, stats, etc.)",
  strategy: Strategy.COOKIE,
  args: [
    { name: "bvid", required: true, positional: true, help: "BV ID, video URL, or b23.tv short link" }
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for bilibili video");
    }
    const input = String(kwargs.bvid ?? "").trim();
    const bilibiliUrlMatch = input.match(/bilibili\.com\/(?:video|bangumi\/play)\/(BV[A-Za-z0-9]+)/i);
    const bvid = bilibiliUrlMatch ? bilibiliUrlMatch[1] : await resolveBvid(input);
    await page.goto(`https://www.bilibili.com/video/${bvid}/`);
    const payload = await apiGet(page, "/x/web-interface/view", {
      params: { bvid }
    });
    if (payload.code !== 0) {
      throw new CommandExecutionError(`Bilibili view API failed: ${payload.message} (${payload.code})`);
    }
    const d = payload.data || {};
    const stat = d.stat || {};
    const owner = d.owner || {};
    const pubDate = d.pubdate ? new Date(d.pubdate * 1e3).toISOString().slice(0, 16).replace("T", " ") : "";
    const dur = d.duration || 0;
    const mm = Math.floor(dur / 60);
    const ss = dur % 60;
    return [
      { field: "bvid", value: d.bvid ?? "" },
      { field: "aid", value: String(d.aid ?? "") },
      { field: "title", value: d.title ?? "" },
      { field: "author", value: owner.name ? `${owner.name} (mid: ${owner.mid})` : "" },
      { field: "category", value: d.tname_v2 || d.tname || "" },
      { field: "publish_time", value: pubDate },
      { field: "duration", value: dur ? `${mm}m${ss}s (${dur}s)` : "" },
      { field: "view", value: String(stat.view ?? "") },
      { field: "danmaku", value: String(stat.danmaku ?? "") },
      { field: "reply", value: String(stat.reply ?? "") },
      { field: "like", value: String(stat.like ?? "") },
      { field: "coin", value: String(stat.coin ?? "") },
      { field: "favorite", value: String(stat.favorite ?? "") },
      { field: "share", value: String(stat.share ?? "") },
      { field: "parts", value: String(d.videos ?? 1) },
      { field: "thumbnail", value: d.pic ?? "" },
      { field: "description", value: d.desc ?? "" }
    ];
  }
});
