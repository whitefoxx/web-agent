// ../browser-agent/opencli/clis/douyin/hashtag.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js
import { AuthRequiredError, CommandExecutionError as CommandExecutionError2 } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/douyin/_shared/evaluate-result.js
import { CommandExecutionError } from "@jackwener/opencli/errors";
function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}

// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js
function isAuthLikeError(code, message) {
  const text = String(message ?? "");
  return code === 401 || code === 403 || /login|cookie|auth|captcha|verify|forbidden|permission|登录|登陆|权限|验证|验证码/i.test(text);
}
async function browserFetch(page, method, url, options = {}) {
  const js = `
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ${Number(options.timeoutMs ?? 3e4)});
      try {
        const res = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...${JSON.stringify(options.headers ?? {})}
          },
          ${options.body ? `body: JSON.stringify(${JSON.stringify(options.body)}),` : ""}
        });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (error) {
          return { status_code: res.ok ? -2 : res.status, status_msg: \`JSON parse failed: \${text.slice(0, 500) || String(error && error.message || error)}\` };
        }
      } catch (error) {
        return { status_code: -1, status_msg: String(error && error.message || error) };
      } finally {
        clearTimeout(timer);
      }
    })()
  `;
  let result;
  try {
    result = unwrapEvaluateResult(await page.evaluate(js));
  } catch (error) {
    throw new CommandExecutionError2(`Douyin API request failed (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result == null) {
    throw new CommandExecutionError2(`Empty response from Douyin API (${method} ${url})`);
  }
  if (Array.isArray(result) || typeof result !== "object") {
    throw new CommandExecutionError2(`Malformed response from Douyin API (${method} ${url})`);
  }
  if (result && typeof result === "object" && "status_code" in result) {
    const code = result.status_code;
    if (code !== 0) {
      const msg = result.status_msg ?? result.message ?? "unknown error";
      if (isAuthLikeError(code, msg)) {
        throw new AuthRequiredError("creator.douyin.com", `Douyin API auth/permission error ${code} at ${method} ${url}: ${msg}`);
      }
      throw new CommandExecutionError2(`Douyin API error ${code} at ${method} ${url}: ${msg}`);
    }
  }
  return result;
}

// ../browser-agent/opencli/clis/douyin/hashtag.js
import { ArgumentError, CommandExecutionError as CommandExecutionError3 } from "@jackwener/opencli/errors";
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireListField(res, field, action) {
  if (!isPlainObject(res)) {
    throw new CommandExecutionError3(`douyin hashtag ${action}: API returned malformed payload`);
  }
  const list = res[field];
  if (list === void 0 || list === null) return [];
  if (!Array.isArray(list)) {
    throw new CommandExecutionError3(`douyin hashtag ${action}: API returned malformed "${field}"`);
  }
  return list;
}
function validateHashtagArgs(kwargs) {
  const action = kwargs.action;
  if (action === "search") {
    const keyword = String(kwargs.keyword ?? "").trim();
    if (!keyword) {
      throw new ArgumentError("douyin hashtag search \u9700\u8981 --keyword <\u5173\u952E\u8BCD>", "\u793A\u4F8B: opencli douyin hashtag search --keyword \u7F8E\u98DF");
    }
    return;
  }
  if (action === "suggest") {
    const cover = String(kwargs.cover ?? "").trim();
    if (!cover) {
      throw new ArgumentError("douyin hashtag suggest \u9700\u8981 --cover <cover_uri>", "suggest \u57FA\u4E8E\u5DF2\u4E0A\u4F20\u7684\u89C6\u9891\u5C01\u9762\u505A AI \u63A8\u8350, \u4E0D\u662F\u5173\u952E\u8BCD\u641C\u7D22. \u5173\u952E\u8BCD\u641C\u7D22\u8BF7\u7528 `douyin hashtag search --keyword <\u8BCD>`.");
    }
  }
}
cli({
  site: "douyin",
  name: "hashtag",
  access: "read",
  description: "\u8BDD\u9898\u641C\u7D22 / AI\u63A8\u8350 / \u70ED\u70B9\u8BCD",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "action", required: true, positional: true, choices: ["search", "suggest", "hot"], help: "search=\u5173\u952E\u8BCD\u641C\u7D22 (--keyword \u5FC5\u586B), suggest=AI\u63A8\u8350 (--cover \u5FC5\u586B), hot=\u70ED\u70B9\u8BCD (--keyword \u53EF\u9009)" },
    { name: "keyword", default: "", help: "\u641C\u7D22\u5173\u952E\u8BCD. search \u5FC5\u586B; hot \u53EF\u9009; suggest \u4E0D\u4F7F\u7528 (\u4F20 --cover)" },
    { name: "cover", default: "", help: "\u5C01\u9762 URI (cover_uri). suggest \u5FC5\u586B; \u5176\u5B83 action \u4E0D\u4F7F\u7528" },
    { name: "limit", type: "int", default: 10 }
  ],
  columns: ["name", "id", "view_count"],
  validateArgs: validateHashtagArgs,
  func: async (page, kwargs) => {
    validateHashtagArgs(kwargs);
    const action = kwargs.action;
    if (action === "search") {
      const keyword = String(kwargs.keyword ?? "").trim();
      const url = `https://creator.douyin.com/aweme/v1/challenge/search/?keyword=${encodeURIComponent(keyword)}&count=${kwargs.limit}&aid=1128`;
      const res = await browserFetch(page, "GET", url);
      const list = requireListField(res, "challenge_list", "search");
      const rows = list.flatMap((c) => {
        const info = c?.challenge_info;
        if (!isPlainObject(info)) return [];
        return [{
          name: info.cha_name,
          id: info.cid,
          view_count: info.view_count
        }];
      });
      if (list.length > 0 && rows.length === 0) {
        throw new CommandExecutionError3("douyin hashtag search: API returned challenges but none had stable challenge_info shape");
      }
      return rows;
    }
    if (action === "suggest") {
      const cover = String(kwargs.cover ?? "").trim();
      const url = `https://creator.douyin.com/web/api/media/hashtag/rec/?cover_uri=${encodeURIComponent(cover)}&aid=1128`;
      const res = await browserFetch(page, "GET", url);
      const list = requireListField(res, "hashtag_list", "suggest");
      return list.map((h) => ({ name: h?.name ?? "", id: h?.id ?? "", view_count: h?.view_count ?? 0 }));
    }
    if (action === "hot") {
      const kw = String(kwargs.keyword ?? "").trim();
      const url = `https://creator.douyin.com/aweme/v1/hotspot/recommend/?${kw ? `keyword=${encodeURIComponent(kw)}&` : ""}aid=1128`;
      const res = await browserFetch(page, "GET", url);
      if (!isPlainObject(res)) {
        throw new CommandExecutionError3("douyin hashtag hot: API returned malformed payload");
      }
      const hotspotList = res.hotspot_list;
      const allSentences = res.all_sentences;
      if (hotspotList !== void 0 && hotspotList !== null && !Array.isArray(hotspotList)) {
        throw new CommandExecutionError3('douyin hashtag hot: API returned malformed "hotspot_list"');
      }
      if (allSentences !== void 0 && allSentences !== null && !Array.isArray(allSentences)) {
        throw new CommandExecutionError3('douyin hashtag hot: API returned malformed "all_sentences"');
      }
      const items = Array.isArray(hotspotList) ? hotspotList : Array.isArray(allSentences) ? allSentences.map((h) => ({
        sentence: h?.word ?? "",
        hot_value: h?.hot_value,
        sentence_id: h?.sentence_id ?? ""
      })) : [];
      return items.slice(0, kwargs.limit).map((h) => ({
        name: h?.sentence ?? "",
        id: h && "sentence_id" in h ? h.sentence_id : "",
        view_count: h?.hot_value ?? 0
      }));
    }
    throw new ArgumentError(`\u672A\u77E5\u7684 action: ${action}`);
  }
});
