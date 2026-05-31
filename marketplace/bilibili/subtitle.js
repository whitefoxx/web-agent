// ../browser-agent/opencli/clis/bilibili/subtitle.js
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

// ../browser-agent/opencli/clis/bilibili/subtitle.js
cli({
  site: "bilibili",
  name: "subtitle",
  access: "read",
  description: "获取 Bilibili 视频的字幕",
  domain: "www.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "bvid", required: true, positional: true, help: "Bilibili 视频 BV ID（如 BV1xx411c7mD），或视频 URL / b23.tv 短链" },
    { name: "lang", required: false, help: "字幕语言代码 (如 zh-CN, en-US, ai-zh)，默认取第一个" }
  ],
  columns: ["index", "from", "to", "content"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for bilibili subtitle");
    const bvid = await resolveBvid(kwargs.bvid);
    let view;
    try {
      view = await apiGet(page, "/x/web-interface/view", { params: { bvid } });
    } catch (err) {
      throw new CommandExecutionError(`获取视频信息失败: ${err?.message || err}`);
    }
    if (view?.code !== 0) {
      throw new CommandExecutionError(`获取视频信息失败: ${view?.message ?? "unknown"} (${view?.code})`);
    }
    const cid = view?.data?.cid;
    if (!cid) {
      throw new CommandExecutionError(`无法从 view API 拿到 cid (bvid=${bvid})`);
    }
    let payload;
    try {
      payload = await apiGet(page, "/x/player/wbi/v2", {
        params: { bvid, cid },
        signed: true
      });
    } catch (err) {
      throw new CommandExecutionError(`获取视频播放信息失败: ${err?.message || err}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new CommandExecutionError("获取到的视频播放信息对象不符合预期格式");
    }
    if (payload.code !== 0) {
      throw new CommandExecutionError(`获取视频播放信息失败: ${payload.message} (${payload.code})`);
    }
    const needLoginSubtitle = payload.data?.need_login_subtitle === true;
    const subtitles = payload.data?.subtitle?.subtitles;
    if (!Array.isArray(subtitles)) {
      throw new CommandExecutionError("获取到的字幕列表对象不符合数组格式");
    }
    if (subtitles.length === 0) {
      if (needLoginSubtitle) {
        throw new AuthRequiredError("bilibili.com", "Bilibili subtitles are hidden behind login for this video. Please log in to bilibili.com in Chrome and retry.");
      }
      throw new EmptyResultError("bilibili subtitle", "此视频没有发现外挂或智能字幕。");
    }
    const target = kwargs.lang ? subtitles.find((s) => s.lan === kwargs.lang) || subtitles[0] : subtitles[0];
    if (!target || typeof target !== "object" || !Object.hasOwn(target, "subtitle_url")) {
      throw new CommandExecutionError("字幕条目缺少 subtitle_url 字段");
    }
    const targetSubUrl = typeof target.subtitle_url === "string" ? target.subtitle_url.trim() : "";
    if (!targetSubUrl) {
      throw new AuthRequiredError("bilibili.com", "[风控拦截/未登录] 获取到的 subtitle_url 为空！请确保 CLI 已成功登录且风控未封锁此账号。");
    }
    const finalUrl = targetSubUrl.startsWith("//") ? "https:" + targetSubUrl : targetSubUrl;
    if (!/^https?:\/\//i.test(finalUrl)) {
      throw new CommandExecutionError(`字幕 URL 非法: ${finalUrl}`);
    }
    const fetchJs = `
      (async () => {
         const url = ${JSON.stringify(finalUrl)};
         const res = await fetch(url);
         const text = await res.text();

         if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
            return { error: 'HTML', text: text.substring(0, 100), url };
         }

         try {
             const subJson = JSON.parse(text);
             // B站真实返回格式是 { font_size: 0.4, font_color: "#FFFFFF", background_alpha: 0.5, background_color: "#9C27B0", Stroke: "none", type: "json" , body: [{from: 0, to: 0, content: ""}] }
             if (Array.isArray(subJson?.body)) return { success: true, data: subJson.body };
             if (Array.isArray(subJson)) return { success: true, data: subJson };
             return { error: 'UNKNOWN_JSON', data: subJson };
         } catch (e) {
             return { error: 'PARSE_FAILED', text: text.substring(0, 100) };
         }
      })()
    `;
    let items;
    try {
      items = await page.evaluate(fetchJs);
    } catch (err) {
      throw new CommandExecutionError(`字幕获取失败: ${err?.message || err}`);
    }
    if (items?.error) {
      throw new CommandExecutionError(`字幕获取失败: ${items.error}${items.text ? " — " + items.text : ""}`);
    }
    if (!items || typeof items !== "object" || items.success !== true) {
      throw new CommandExecutionError("字幕获取结果对象不符合预期格式");
    }
    const finalItems = items.data;
    if (!Array.isArray(finalItems)) {
      throw new CommandExecutionError("解析到的字幕列表对象不符合数组格式");
    }
    if (finalItems.length === 0) {
      throw new EmptyResultError("bilibili subtitle", "字幕文件中没有字幕片段。");
    }
    return finalItems.map((item, idx) => {
      const from = Number(item?.from);
      const to = Number(item?.to);
      if (!item || typeof item !== "object" || !Number.isFinite(from) || !Number.isFinite(to)) {
        throw new CommandExecutionError("字幕片段缺少有效 from/to 时间戳");
      }
      return {
        index: idx + 1,
        from: from.toFixed(2) + "s",
        to: to.toFixed(2) + "s",
        content: String(item.content ?? "")
      };
    });
  }
});
