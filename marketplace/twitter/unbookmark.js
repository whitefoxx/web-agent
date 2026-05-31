// ../browser-agent/opencli/clis/twitter/unbookmark.js
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

// ../browser-agent/opencli/clis/twitter/unbookmark.js
cli({
  site: "twitter",
  name: "unbookmark",
  access: "write",
  description: "Remove a tweet from bookmarks",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "url", type: "string", positional: true, required: true, help: "Tweet URL to unbookmark" }
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for twitter unbookmark");
    const target = parseTweetUrl(kwargs.url);
    await page.goto(target.url);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    const result = await page.evaluate(`(async () => {
        try {
            ${buildTwitterArticleScopeSource(target.id)}
            let attempts = 0;
            let removeBtn = null;
            let targetArticle = null;

            while (attempts < 20) {
                targetArticle = findTargetArticle();
                // Check if not bookmarked (already removed)
                const bookmarkBtn = targetArticle?.querySelector('[data-testid="bookmark"]');
                if (bookmarkBtn) {
                    return { ok: true, message: 'Tweet is not bookmarked (already removed).' };
                }

                removeBtn = targetArticle?.querySelector('[data-testid="removeBookmark"]') || null;
                if (removeBtn) break;

                await new Promise(r => setTimeout(r, 500));
                attempts++;
            }

            if (!removeBtn) {
                return { ok: false, message: 'Could not find Remove Bookmark button on the requested tweet. Are you logged in?' };
            }

            removeBtn.click();
            await new Promise(r => setTimeout(r, 1000));

            // Verify
            const verifyArticle = findTargetArticle() || targetArticle;
            const verify = verifyArticle?.querySelector('[data-testid="bookmark"]');
            if (verify) {
                return { ok: true, message: 'Tweet successfully removed from bookmarks.' };
            } else {
                return { ok: false, message: 'Unbookmark action initiated but UI did not update.' };
            }
        } catch (e) {
            return { ok: false, message: e.toString() };
        }
    })()`);
    if (result.ok)
      await page.wait(2);
    return [{
      status: result.ok ? "success" : "failed",
      message: result.message
    }];
  }
});
