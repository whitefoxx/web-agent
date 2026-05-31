// ../browser-agent/opencli/clis/bilibili/following.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/bilibili/utils.js
import https from "node:https";

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
async function getSelfUid(page) {
  const nav = await getNavData(page);
  const mid = nav?.data?.mid;
  if (!mid)
    throw new AuthRequiredError("bilibili.com");
  return String(mid);
}
async function resolveUid(page, input) {
  if (/^\d+$/.test(input))
    return input;
  const payload = await apiGet(page, "/x/web-interface/wbi/search/type", {
    params: { search_type: "bili_user", keyword: input },
    signed: true
  });
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data) || !Object.hasOwn(payload.data, "result")) {
    throw new CommandExecutionError(`Bilibili user search returned malformed result for ${input}`);
  }
  const results = payload.data.result;
  if (!Array.isArray(results)) {
    throw new CommandExecutionError(`Bilibili user search returned malformed result for ${input}`);
  }
  if (results.length > 0) {
    const mid = String(results[0]?.mid ?? "").trim();
    if (!mid) {
      throw new CommandExecutionError(`Bilibili user search returned malformed mid for ${input}`);
    }
    return mid;
  }
  throw new EmptyResultError(`bilibili user search: ${input}`, "User may not exist or username may have changed.");
}

// ../browser-agent/opencli/clis/bilibili/following.js
cli({
  site: "bilibili",
  name: "following",
  access: "read",
  description: "获取 Bilibili 用户的关注列表",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "uid", positional: true, required: false, help: "目标用户 ID（默认为当前登录用户）" },
    { name: "page", type: "int", required: false, default: 1, help: "页码" },
    { name: "limit", type: "int", required: false, default: 50, help: "每页数量 (最大 50)" }
  ],
  columns: ["mid", "name", "sign", "following", "fans"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for bilibili following");
    const uid = kwargs.uid ? await resolveUid(page, kwargs.uid) : await getSelfUid(page);
    const pn = kwargs.page ?? 1;
    const ps = Math.min(kwargs.limit ?? 50, 50);
    const payload = await fetchJson(page, `https://api.bilibili.com/x/relation/followings?vmid=${uid}&pn=${pn}&ps=${ps}&order=desc`);
    if (payload.code !== 0) {
      throw new CommandExecutionError(`获取关注列表失败: ${payload.message} (${payload.code})`);
    }
    const list = payload.data?.list || [];
    if (list.length === 0) {
      return [{ mid: "-", name: `共 ${payload.data?.total ?? 0} 人关注，当前页无数据`, sign: "", following: "", fans: "" }];
    }
    return list.map((u) => ({
      mid: u.mid,
      name: u.uname,
      sign: (u.sign || "").slice(0, 40),
      following: u.attribute === 6 ? "互相关注" : "已关注",
      fans: u.official_verify?.desc || ""
    }));
  }
});
