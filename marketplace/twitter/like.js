// ../browser-agent/opencli/clis/twitter/like.js
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/twitter/shared.js

var TWEET_PATH_PATTERN = /^\/(?:[^/]+|i)\/status\/(\d+)\/?$/;
var TWEET_HOSTS = /* @__PURE__ */ new Set(["x.com", "twitter.com"]);
function isTwitterHost(hostname) {
  return TWEET_HOSTS.has(hostname) || hostname.endsWith(".x.com") || hostname.endsWith(".twitter.com");
}
function parseTweetUrl(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) {
    throw new ArgumentError("twitter tweet URL cannot be empty", "Example: opencli twitter retweet https://x.com/jack/status/20");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ArgumentError(`Invalid tweet URL: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !isTwitterHost(hostname)) {
    throw new ArgumentError(`Invalid tweet URL host: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
  }
  const match = parsed.pathname.match(TWEET_PATH_PATTERN);
  if (!match?.[1]) {
    throw new ArgumentError(`Could not extract tweet ID from URL: ${value}`, "Use a full https://x.com/<user>/status/<id> URL");
  }
  return {
    id: match[1],
    url: parsed.toString()
  };
}
function buildTwitterArticleScopeSource(tweetId) {
  return `
        const tweetId = ${JSON.stringify(tweetId)};
        const __twTweetPathRe = /^\\/(?:[^/]+|i)\\/status\\/(\\d+)\\/?$/;
        const __twIsTwitterHost = (hostname) => hostname === 'x.com'
            || hostname === 'twitter.com'
            || hostname.endsWith('.x.com')
            || hostname.endsWith('.twitter.com');
        const __twGetStatusIdFromHref = (href) => {
            try {
                const parsed = new URL(href, window.location.origin);
                if (parsed.protocol !== 'https:' || !__twIsTwitterHost(parsed.hostname.toLowerCase())) {
                    return null;
                }
                return parsed.pathname.match(__twTweetPathRe)?.[1] || null;
            } catch {
                return null;
            }
        };
        const __twHasLinkToTarget = (root) => Array.from(root.querySelectorAll('a[href*="/status/"]'))
            .some((link) => __twGetStatusIdFromHref(link.href) === tweetId);
        const findTargetArticle = () => Array.from(document.querySelectorAll('article'))
            .find(__twHasLinkToTarget);
    `;
}

// ../browser-agent/opencli/clis/twitter/like.js
cli({
  site: "twitter",
  name: "like",
  access: "write",
  description: "Like a specific tweet",
  domain: "x.com",
  strategy: Strategy.UI,
  // Utilizes internal DOM flows for interaction
  browser: true,
  args: [
    { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to like" }
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for twitter like");
    const target = parseTweetUrl(kwargs.url);
    await page.goto(target.url);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    const result = await page.evaluate(`(async () => {
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            // Poll for the tweet to render. We scope state probes to the
            // article matching the requested status id — on conversation
            // pages multiple articles render and a bare querySelector would
            // grab the first one (silent: like the wrong tweet).
            let attempts = 0;
            let likeBtn = null;
            let unlikeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                likeBtn = targetArticle?.querySelector('[data-testid="like"]') || null;
                unlikeBtn = targetArticle?.querySelector('[data-testid="unlike"]') || null;

                if (likeBtn || unlikeBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            // Check if it's already liked
            if (unlikeBtn) {
                return { ok: true, message: 'Tweet is already liked.' };
            }

            if (!likeBtn) {
                return { ok: false, message: 'Could not find the Like button on this tweet after waiting 10 seconds. Are you logged in?' };
            }

            // Click Like
            likeBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify success by checking if the 'unlike' button reappeared
            const verifyArticle = findTargetArticle() || targetArticle;
            const verifyBtn = verifyArticle?.querySelector('[data-testid="unlike"]');
            if (verifyBtn) {
                return { ok: true, message: 'Tweet successfully liked.' };
            } else {
                return { ok: false, message: 'Like action was initiated but UI did not update as expected.' };
            }
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`);
    if (result.ok) {
      await page.wait(2);
    }
    return [{
      status: result.ok ? "success" : "failed",
      message: result.message
    }];
  }
});
