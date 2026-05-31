// ../browser-agent/opencli/clis/twitter/delete.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
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

// ../browser-agent/opencli/clis/twitter/delete.js
function buildDeleteScript(tweetId) {
  return `(async () => {
      try {
          const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
          ${buildTwitterArticleScopeSource(tweetId)}
          const targetArticle = findTargetArticle();

          if (!targetArticle) {
              return { ok: false, message: 'Could not find the tweet card matching the requested URL.' };
          }

          const buttons = Array.from(targetArticle.querySelectorAll('button,[role="button"]'));
          const moreMenu = buttons.find((el) => visible(el) && (el.getAttribute('aria-label') || '').trim() === 'More');
          if (!moreMenu) {
              return { ok: false, message: 'Could not find the "More" context menu on the matched tweet. Are you sure you are logged in and looking at a valid tweet?' };
          }

          moreMenu.click();
          await new Promise(r => setTimeout(r, 1000));

          const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
          const deleteBtn = items.find((item) => {
              const text = (item.textContent || '').trim();
              return text.includes('Delete') && !text.includes('List');
          });

          if (!deleteBtn) {
              return { ok: false, message: 'The matched tweet menu did not contain Delete. This tweet may not belong to you.' };
          }

          deleteBtn.click();
          await new Promise(r => setTimeout(r, 1000));

          const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
          if (confirmBtn) {
              confirmBtn.click();
              return { ok: true, message: 'Tweet successfully deleted.' };
          } else {
              return { ok: false, message: 'Delete confirmation dialog did not appear.' };
          }
      } catch (e) {
          return { ok: false, message: e.toString() };
      }
  })()`;
}
cli({
  site: "twitter",
  name: "delete",
  access: "write",
  description: "Delete a specific tweet by URL",
  domain: "x.com",
  strategy: Strategy.UI,
  // Utilizes internal DOM flows for interaction
  browser: true,
  args: [
    { name: "url", type: "string", required: true, positional: true, help: "The URL of the tweet to delete" }
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for twitter delete");
    const target = parseTweetUrl(kwargs.url);
    await page.goto(target.url);
    await page.wait({ selector: '[data-testid="primaryColumn"]' });
    const result = await page.evaluate(buildDeleteScript(target.id));
    if (result.ok) {
      await page.wait(2);
    }
    return [{
      status: result.ok ? "success" : "failed",
      message: result.message
    }];
  }
});
var __test__ = {
  buildDeleteScript
};
export {
  __test__
};
