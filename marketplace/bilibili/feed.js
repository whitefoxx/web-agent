// ../browser-agent/opencli/clis/bilibili/feed.js
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
function payloadData(payload) {
  return payload?.data ?? payload;
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

// ../browser-agent/opencli/clis/bilibili/feed.js
var TYPE_MAP = {
  DYNAMIC_TYPE_AV: "video",
  DYNAMIC_TYPE_DRAW: "draw",
  DYNAMIC_TYPE_ARTICLE: "article",
  DYNAMIC_TYPE_FORWARD: "forward",
  DYNAMIC_TYPE_WORD: "text",
  DYNAMIC_TYPE_LIVE_RCMD: "live",
  DYNAMIC_TYPE_PGC: "bangumi"
};
function parseItem(item) {
  const modules = item.modules ?? {};
  const authorModule = modules.module_author ?? {};
  const dynamicModule = modules.module_dynamic ?? {};
  const major = dynamicModule.major ?? {};
  const stat = modules.module_stat ?? {};
  let title = "";
  let url = item.id_str ? `https://t.bilibili.com/${item.id_str}` : "";
  const itemType = TYPE_MAP[item.type] ?? item.type ?? "";
  if (major.archive) {
    title = major.archive.title ?? "";
    url = major.archive.jump_url ? `https:${major.archive.jump_url}` : url;
  }
  if (!title && major.article) {
    title = major.article.title ?? "";
    url = major.article.jump_url ? `https:${major.article.jump_url}` : url;
  }
  if (!title && dynamicModule.desc?.text) {
    title = stripHtml(dynamicModule.desc.text).slice(0, 60);
  }
  if (!title && major.draw) {
    const imgCount = major.draw.items?.length ?? 0;
    title = imgCount > 0 ? `[图片x${imgCount}]` : "[图文动态]";
  }
  if (!title && item.basic?.is_only_fans) {
    title = "[充电专属]";
  }
  if (!title && item.type === "DYNAMIC_TYPE_FORWARD") {
    title = "[转发动态]";
  }
  if (!title) {
    title = `[${itemType || "动态"}]`;
  }
  const time = authorModule.pub_time ?? "";
  const likes = stat.like?.count ?? 0;
  const comments = stat.comment?.count ?? 0;
  return { title, url, itemType, author: authorModule.name ?? "", time, likes, comments };
}
cli({
  site: "bilibili",
  name: "feed",
  access: "read",
  description: "动态时间线（不传 uid 查关注时间线，传 uid 查指定用户动态）",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "uid", positional: true, required: false, help: "用户 UID 或用户名（不传则显示关注时间线）" },
    { name: "limit", type: "int", default: 20, help: "Max results to return" },
    { name: "type", default: "all", help: "Filter: all, video, article, draw, text" },
    { name: "pages", type: "int", default: 1, help: "Number of pages to fetch (each ~20 items)" }
  ],
  columns: ["rank", "time", "author", "title", "type", "likes", "url"],
  func: async (page, kwargs) => {
    const maxResults = Number(kwargs.limit) || 20;
    const maxPages = Number(kwargs.pages) || 1;
    const filterType = kwargs.type === "all" ? "" : kwargs.type ?? "";
    const isUserFeed = !!kwargs.uid;
    const uid = isUserFeed ? await resolveUid(page, String(kwargs.uid)) : null;
    const rows = [];
    let offset = "";
    for (let p = 0; p < maxPages; p++) {
      if (rows.length >= maxResults) break;
      let payload;
      if (isUserFeed) {
        const params = { host_mid: uid, timezone_offset: -480 };
        if (offset) params.offset = offset;
        payload = await apiGet(page, "/x/polymer/web-dynamic/v1/feed/space", { params });
      } else {
        const params = {
          timezone_offset: -480,
          type: filterType || "all",
          page: p + 1
        };
        if (offset) params.offset = offset;
        payload = await apiGet(page, "/x/polymer/web-dynamic/v1/feed/all", { params });
      }
      const data = payloadData(payload) ?? {};
      const items = data.items ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        if (rows.length >= maxResults) break;
        const parsed = parseItem(item);
        if (filterType && parsed.itemType !== filterType) continue;
        rows.push({
          rank: rows.length + 1,
          time: parsed.time,
          author: parsed.author,
          title: parsed.title,
          type: parsed.itemType,
          likes: parsed.likes,
          url: parsed.url
        });
      }
      offset = data.offset ?? items[items.length - 1]?.id_str ?? "";
      if (!offset || !data.has_more) break;
    }
    return rows;
  }
});
cli({
  site: "bilibili",
  name: "feed-detail",
  access: "read",
  description: "查看 Bilibili 动态详情（支持充电专属内容）",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "id", positional: true, required: true, help: "动态 ID（从 feed 命令的 url 中获取）" }
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const id = String(kwargs.id);
    const payload = await apiGet(page, "/x/polymer/web-dynamic/v1/detail", {
      params: { id, timezone_offset: -480 }
    });
    const rows = [];
    const data = payloadData(payload);
    const item = data?.item;
    if (!item) {
      rows.push({ field: "error", value: "动态不存在或无权查看" });
      return rows;
    }
    const modules = item.modules ?? {};
    const author = modules.module_author ?? {};
    const dynamicModule = modules.module_dynamic ?? {};
    const major = dynamicModule.major ?? {};
    const stat = modules.module_stat ?? {};
    rows.push({ field: "id", value: item.id_str ?? id });
    rows.push({ field: "author", value: author.name ?? "" });
    rows.push({ field: "time", value: author.pub_time ?? "" });
    rows.push({ field: "type", value: TYPE_MAP[item.type] ?? item.type ?? "" });
    if (dynamicModule.desc?.text) {
      rows.push({ field: "text", value: stripHtml(dynamicModule.desc.text) });
    }
    if (major.archive) {
      rows.push({ field: "video_title", value: major.archive.title ?? "" });
      rows.push({ field: "video_desc", value: major.archive.desc ?? "" });
      rows.push({ field: "video_url", value: major.archive.jump_url ? `https:${major.archive.jump_url}` : "" });
      rows.push({ field: "play", value: String(major.archive.stat?.play ?? "") });
      rows.push({ field: "danmaku", value: String(major.archive.stat?.danmaku ?? "") });
    }
    if (major.article) {
      rows.push({ field: "article_title", value: major.article.title ?? "" });
      rows.push({ field: "article_url", value: major.article.jump_url ? `https:${major.article.jump_url}` : "" });
    }
    if (major.draw?.items?.length) {
      rows.push({ field: "images", value: major.draw.items.map((img) => img.src).join("\n") });
    }
    if (major.opus?.summary?.text) {
      rows.push({ field: "opus_text", value: stripHtml(major.opus.summary.text) });
    }
    if (major.opus?.title) {
      rows.push({ field: "opus_title", value: major.opus.title });
    }
    if (item.orig) {
      const origAuthor = item.orig.modules?.module_author?.name ?? "";
      const origDesc = item.orig.modules?.module_dynamic?.desc?.text ?? "";
      rows.push({ field: "forward_from", value: origAuthor });
      if (origDesc) rows.push({ field: "forward_text", value: stripHtml(origDesc).slice(0, 200) });
    }
    rows.push({ field: "likes", value: String(stat.like?.count ?? 0) });
    rows.push({ field: "comments", value: String(stat.comment?.count ?? 0) });
    rows.push({ field: "forwards", value: String(stat.forward?.count ?? 0) });
    rows.push({ field: "url", value: `https://t.bilibili.com/${item.id_str ?? id}` });
    return rows;
  }
});
