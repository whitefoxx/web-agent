// ../browser-agent/opencli/clis/bilibili/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/bilibili/utils.js
import https from "node:https";
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
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
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/gi, " ").trim();
}
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

// ../browser-agent/opencli/clis/bilibili/search.js
cli({
  site: "bilibili",
  name: "search",
  access: "read",
  description: "Search Bilibili videos or users",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "query", required: true, positional: true, help: "Search keyword" },
    { name: "type", default: "video", help: "video or user" },
    { name: "page", type: "int", default: 1, help: "Result page" },
    { name: "limit", type: "int", default: 20, help: "Number of results" }
  ],
  columns: ["rank", "title", "author", "score", "url"],
  func: async (page, kwargs) => {
    const { query: keyword, type = "video", page: pageNum = 1, limit = 20 } = kwargs;
    const searchType = type === "user" ? "bili_user" : "video";
    const payload = await apiGet(page, "/x/web-interface/wbi/search/type", { params: { search_type: searchType, keyword, page: pageNum }, signed: true });
    const results = payload?.data?.result ?? [];
    return results.slice(0, Number(limit)).map((item, i) => {
      if (searchType === "bili_user") {
        return { rank: i + 1, title: stripHtml(item.uname ?? ""), author: (item.usign ?? "").trim(), score: item.fans ?? 0, url: item.mid ? `https://space.bilibili.com/${item.mid}` : "" };
      }
      return { rank: i + 1, title: stripHtml(item.title ?? ""), author: item.author ?? "", score: item.play ?? 0, url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "" };
    });
  }
});
