// ../browser-agent/opencli/clis/douyin/user-videos.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CliError, CommandExecutionError as CommandExecutionError3, EmptyResultError } from "@jackwener/opencli/errors";

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

// ../browser-agent/opencli/clis/douyin/_shared/public-api.js
async function fetchDouyinUserVideos(page, secUid, count) {
  const params = new URLSearchParams({
    sec_user_id: secUid,
    max_cursor: "0",
    count: String(count),
    aid: "6383"
  });
  const data = await browserFetch(page, "GET", `https://www.douyin.com/aweme/v1/web/aweme/post/?${params.toString()}`, {
    headers: { referer: "https://www.douyin.com/" }
  });
  return data.aweme_list || [];
}
async function fetchDouyinComments(page, awemeId, count) {
  const params = new URLSearchParams({
    aweme_id: awemeId,
    count: String(count),
    cursor: "0",
    aid: "6383"
  });
  const data = await browserFetch(page, "GET", `https://www.douyin.com/aweme/v1/web/comment/list/?${params.toString()}`, {
    headers: { referer: "https://www.douyin.com/" }
  });
  return (data.comments || []).slice(0, count).map((comment) => ({
    text: comment.text || "",
    digg_count: comment.digg_count ?? 0,
    nickname: comment.user?.nickname || ""
  }));
}

// ../browser-agent/opencli/clis/douyin/user-videos.js
var MAX_USER_VIDEOS_LIMIT = 20;
var USER_VIDEO_COMMENT_CONCURRENCY = 4;
var DEFAULT_COMMENT_LIMIT = 10;
function normalizeUserVideosLimit(limit) {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric))
    return MAX_USER_VIDEOS_LIMIT;
  return Math.min(MAX_USER_VIDEOS_LIMIT, Math.max(1, Math.round(numeric)));
}
function normalizeCommentLimit(limit) {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric))
    return DEFAULT_COMMENT_LIMIT;
  return Math.min(DEFAULT_COMMENT_LIMIT, Math.max(1, Math.round(numeric)));
}
async function mapInBatches(items, concurrency, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += concurrency) {
    const chunk = items.slice(index, index + concurrency);
    results.push(...await Promise.all(chunk.map(mapper)));
  }
  return results;
}
async function fetchTopComments(page, awemeId, count) {
  try {
    return await fetchDouyinComments(page, awemeId, count);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CommandExecutionError3(`Failed to fetch Douyin comments for video ${awemeId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
cli({
  site: "douyin",
  name: "user-videos",
  access: "read",
  description: "\u83B7\u53D6\u6307\u5B9A\u7528\u6237\u7684\u89C6\u9891\u5217\u8868\uFF08\u542B\u4E0B\u8F7D\u5730\u5740\u548C\u70ED\u95E8\u8BC4\u8BBA\uFF09",
  domain: "www.douyin.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "sec_uid", type: "string", required: true, positional: true, help: "\u7528\u6237 sec_uid\uFF08URL \u672B\u5C3E\u90E8\u5206\uFF09" },
    { name: "limit", type: "int", default: 20, help: "\u83B7\u53D6\u6570\u91CF\uFF08\u6700\u5927 20\uFF09" },
    { name: "with_comments", type: "bool", default: true, help: "\u5305\u542B\u70ED\u95E8\u8BC4\u8BBA\uFF08\u9ED8\u8BA4: true\uFF09" },
    { name: "comment_limit", type: "int", default: 10, help: "\u6BCF\u4E2A\u89C6\u9891\u83B7\u53D6\u591A\u5C11\u6761\u8BC4\u8BBA\uFF08\u6700\u5927 10\uFF09" }
  ],
  columns: ["index", "aweme_id", "title", "duration", "digg_count", "play_url", "top_comments"],
  func: async (page, kwargs) => {
    const secUid = kwargs.sec_uid;
    const limit = normalizeUserVideosLimit(kwargs.limit);
    const withComments = kwargs.with_comments !== false;
    const commentLimit = normalizeCommentLimit(kwargs.comment_limit);
    await page.goto(`https://www.douyin.com/user/${secUid}`);
    await page.wait(3);
    const awemeList = (await fetchDouyinUserVideos(page, secUid, limit)).slice(0, limit);
    if (awemeList.length === 0) {
      throw new EmptyResultError("douyin user-videos", `No videos were returned for sec_uid ${secUid}. Confirm the user exists and the Douyin session is valid.`);
    }
    const videos = withComments ? await mapInBatches(awemeList, USER_VIDEO_COMMENT_CONCURRENCY, async (video) => ({
      ...video,
      top_comments: await fetchTopComments(page, video.aweme_id, commentLimit)
    })) : awemeList.map((video) => ({ ...video, top_comments: [] }));
    return videos.map((video, index) => {
      const playUrl = video.video?.play_addr?.url_list?.[0] ?? "";
      return {
        index: index + 1,
        aweme_id: video.aweme_id,
        title: video.desc ?? "",
        duration: Math.round((video.video?.duration ?? 0) / 1e3),
        digg_count: video.statistics?.digg_count ?? 0,
        play_url: playUrl,
        top_comments: video.top_comments ?? []
      };
    });
  }
});
export {
  DEFAULT_COMMENT_LIMIT,
  MAX_USER_VIDEOS_LIMIT,
  USER_VIDEO_COMMENT_CONCURRENCY,
  normalizeCommentLimit,
  normalizeUserVideosLimit
};
