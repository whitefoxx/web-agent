// ../browser-agent/opencli/clis/douyin/update.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError } from "@jackwener/opencli/errors";

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

// ../browser-agent/opencli/clis/douyin/_shared/timing.js
var MIN_OFFSET = 7200;
var MAX_OFFSET = 14 * 86400;
function validateTiming(unixSeconds) {
  if (!Number.isFinite(unixSeconds))
    throw new Error(`\u65E0\u6548\u7684\u65F6\u95F4\u6233: ${unixSeconds}`);
  const now = Math.floor(Date.now() / 1e3);
  if (unixSeconds < now + MIN_OFFSET)
    throw new Error(`\u5B9A\u65F6\u53D1\u5E03\u65F6\u95F4\u5FC5\u987B\u5728\u81F3\u5C11 2 \u5C0F\u65F6\u540E`);
  if (unixSeconds > now + MAX_OFFSET)
    throw new Error(`\u5B9A\u65F6\u53D1\u5E03\u65F6\u95F4\u4E0D\u80FD\u8D85\u8FC7 14 \u5929`);
}
function toUnixSeconds(input) {
  if (typeof input === "number")
    return input;
  if (/^\d+$/.test(input)) {
    return Number(input);
  }
  const ms = new Date(input).getTime();
  if (isNaN(ms))
    throw new Error(`\u65E0\u6548\u7684\u65F6\u95F4\u683C\u5F0F: "${input}"`);
  return Math.floor(ms / 1e3);
}

// ../browser-agent/opencli/clis/douyin/update.js
cli({
  site: "douyin",
  name: "update",
  access: "write",
  description: "\u66F4\u65B0\u89C6\u9891\u4FE1\u606F",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "aweme_id", required: true, positional: true, help: "\u6296\u97F3\u4F5C\u54C1 ID\uFF08aweme_id\uFF0C\u53EF\u4ECE\u4F5C\u54C1 URL \u672B\u5C3E\u83B7\u53D6\uFF09" },
    { name: "reschedule", default: "", help: "\u65B0\u7684\u53D1\u5E03\u65F6\u95F4\uFF08ISO8601 \u6216 Unix \u79D2\uFF09" },
    { name: "caption", default: "", help: "\u65B0\u7684\u6B63\u6587\u5185\u5BB9" }
  ],
  columns: ["status"],
  func: async (page, kwargs) => {
    if (!kwargs.reschedule && !kwargs.caption) {
      throw new ArgumentError("\u5FC5\u987B\u63D0\u4F9B --reschedule \u6216 --caption");
    }
    if (kwargs.reschedule) {
      const newTime = toUnixSeconds(kwargs.reschedule);
      validateTiming(newTime);
      await browserFetch(page, "POST", "https://creator.douyin.com/web/api/media/update/timer/?aid=1128", { body: { aweme_id: kwargs.aweme_id, publish_time: newTime } });
    }
    if (kwargs.caption) {
      await browserFetch(page, "POST", "https://creator.douyin.com/web/api/media/update/desc/?aid=1128", { body: { aweme_id: kwargs.aweme_id, desc: kwargs.caption } });
    }
    return [{ status: "\u2705 \u66F4\u65B0\u6210\u529F" }];
  }
});
