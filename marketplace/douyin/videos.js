// ../browser-agent/opencli/clis/douyin/videos.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/douyin/_shared/evaluate-result.js

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
    throw new CommandExecutionError(`Douyin API request failed (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result == null) {
    throw new CommandExecutionError(`Empty response from Douyin API (${method} ${url})`);
  }
  if (Array.isArray(result) || typeof result !== "object") {
    throw new CommandExecutionError(`Malformed response from Douyin API (${method} ${url})`);
  }
  if (result && typeof result === "object" && "status_code" in result) {
    const code = result.status_code;
    if (code !== 0) {
      const msg = result.status_msg ?? result.message ?? "unknown error";
      if (isAuthLikeError(code, msg)) {
        throw new AuthRequiredError("creator.douyin.com", `Douyin API auth/permission error ${code} at ${method} ${url}: ${msg}`);
      }
      throw new CommandExecutionError(`Douyin API error ${code} at ${method} ${url}: ${msg}`);
    }
  }
  return result;
}

// ../browser-agent/opencli/clis/douyin/videos.js
function normalizeVideoStatus(status, publicTime) {
  if (typeof status === "number")
    return status;
  if (!status)
    return publicTime && publicTime > Date.now() / 1e3 ? "scheduled" : "published";
  if (status.is_delete)
    return "deleted";
  if (status.is_prohibited)
    return "prohibited";
  if (status.in_reviewing)
    return "reviewing";
  if (status.is_private)
    return "private";
  if (publicTime && publicTime > Date.now() / 1e3)
    return "scheduled";
  return "published";
}
cli({
  site: "douyin",
  name: "videos",
  access: "read",
  description: "获取作品列表",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "每页数量" },
    { name: "page", type: "int", default: 1, help: "页码" },
    { name: "status", default: "all", choices: ["all", "published", "reviewing", "scheduled"] }
  ],
  columns: ["aweme_id", "title", "status", "play_count", "digg_count", "create_time"],
  func: async (page, kwargs) => {
    const statusMap = { all: 0, published: 1, reviewing: 3, scheduled: 0 };
    const statusNum = statusMap[kwargs.status] ?? 0;
    const url = `https://creator.douyin.com/janus/douyin/creator/pc/work_list?page_size=${kwargs.limit}&page_num=${kwargs.page}&status=${statusNum}`;
    const res = await browserFetch(page, "GET", url);
    let items = res.data?.work_list ?? res.aweme_list ?? [];
    if (kwargs.status === "scheduled") {
      items = items.filter((v) => (v.public_time ?? 0) > Date.now() / 1e3);
    }
    return items.map((v) => ({
      aweme_id: v.aweme_id,
      title: v.desc ?? "",
      status: normalizeVideoStatus(v.status, v.public_time),
      play_count: v.statistics?.play_count ?? 0,
      digg_count: v.statistics?.digg_count ?? 0,
      create_time: new Date((v.create_time ?? v.public_time ?? 0) * 1e3).toLocaleString("zh-CN", { timeZone: "Asia/Tokyo" })
    }));
  }
});
