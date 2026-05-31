// ../browser-agent/opencli/clis/douyin/update.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/douyin/_shared/browser-fetch.js

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

// ../browser-agent/opencli/clis/douyin/_shared/timing.js
var MIN_OFFSET = 7200;
var MAX_OFFSET = 14 * 86400;
function validateTiming(unixSeconds) {
  if (!Number.isFinite(unixSeconds))
    throw new Error(`无效的时间戳: ${unixSeconds}`);
  const now = Math.floor(Date.now() / 1e3);
  if (unixSeconds < now + MIN_OFFSET)
    throw new Error(`定时发布时间必须在至少 2 小时后`);
  if (unixSeconds > now + MAX_OFFSET)
    throw new Error(`定时发布时间不能超过 14 天`);
}
function toUnixSeconds(input) {
  if (typeof input === "number")
    return input;
  if (/^\d+$/.test(input)) {
    return Number(input);
  }
  const ms = new Date(input).getTime();
  if (isNaN(ms))
    throw new Error(`无效的时间格式: "${input}"`);
  return Math.floor(ms / 1e3);
}

// ../browser-agent/opencli/clis/douyin/update.js
cli({
  site: "douyin",
  name: "update",
  access: "write",
  description: "更新视频信息",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "aweme_id", required: true, positional: true, help: "抖音作品 ID（aweme_id，可从作品 URL 末尾获取）" },
    { name: "reschedule", default: "", help: "新的发布时间（ISO8601 或 Unix 秒）" },
    { name: "caption", default: "", help: "新的正文内容" }
  ],
  columns: ["status"],
  func: async (page, kwargs) => {
    if (!kwargs.reschedule && !kwargs.caption) {
      throw new ArgumentError("必须提供 --reschedule 或 --caption");
    }
    if (kwargs.reschedule) {
      const newTime = toUnixSeconds(kwargs.reschedule);
      validateTiming(newTime);
      await browserFetch(page, "POST", "https://creator.douyin.com/web/api/media/update/timer/?aid=1128", { body: { aweme_id: kwargs.aweme_id, publish_time: newTime } });
    }
    if (kwargs.caption) {
      await browserFetch(page, "POST", "https://creator.douyin.com/web/api/media/update/desc/?aid=1128", { body: { aweme_id: kwargs.aweme_id, desc: kwargs.caption } });
    }
    return [{ status: "✅ 更新成功" }];
  }
});
