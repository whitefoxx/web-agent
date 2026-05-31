// ../browser-agent/opencli/clis/douyin/collections.js
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

// ../browser-agent/opencli/clis/douyin/collections.js
cli({
  site: "douyin",
  name: "collections",
  access: "read",
  description: "合集列表",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20 }
  ],
  columns: ["mix_id", "name", "item_count"],
  func: async (page, kwargs) => {
    const url = `https://creator.douyin.com/web/api/mix/list/?status=0,1,2,3,6&count=${kwargs.limit}&cursor=0&should_query_new_mix=1&device_platform=web&aid=1128`;
    const res = await browserFetch(page, "GET", url);
    return (res.mix_list ?? []).map((m) => ({
      mix_id: m.mix_id,
      name: m.mix_name,
      item_count: m.item_count
    }));
  }
});
