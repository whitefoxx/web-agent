// ../browser-agent/opencli/clis/twitter/followers.js
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, selectorError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/twitter/shared.js

var SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
var SCREEN_NAME_HOSTS = /* @__PURE__ */ new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
var RESERVED_SCREEN_NAME_PATHS = /* @__PURE__ */ new Set([
  "compose",
  "explore",
  "help",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "logout",
  "messages",
  "notifications",
  "privacy",
  "search",
  "settings",
  "signup",
  "tos"
]);
function normalizeTwitterScreenName(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let candidate = "";
  try {
    const url = raw.startsWith("/") ? new URL(raw, "https://x.com") : new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !SCREEN_NAME_HOSTS.has(url.hostname)) {
      return "";
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return "";
    candidate = segments[0];
  } catch {
    if (raw.includes("/") || raw.includes("?") || raw.includes("#")) return "";
    candidate = raw.replace(/^@+/, "");
  }
  if (!SCREEN_NAME_PATTERN.test(candidate)) return "";
  if (RESERVED_SCREEN_NAME_PATHS.has(candidate.toLowerCase())) return "";
  return candidate;
}
function unwrapBrowserResult(value) {
  if (value && typeof value === "object" && typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
    return value.data;
  }
  return value;
}

// ../browser-agent/opencli/clis/twitter/followers.js
async function extractFollowersFromDOM(page) {
  const script = `() => {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        const out = [];
        for (const cell of cells) {
            // Collect i18n-variable UI strings to strip from the cell text.
            const stripTexts = new Set();
            const buttons = cell.querySelectorAll(
                '[data-testid$="-follow"],[data-testid$="-unfollow"],[data-testid="userFollowIndicator"]'
            );
            for (const el of buttons) {
                const t = (el.innerText || '').trim();
                if (t) stripTexts.add(t);
            }
            const lines = (cell.innerText || '')
                .split('\\n')
                .map(s => s.trim())
                .filter(Boolean)
                .filter(l => !stripTexts.has(l));
            // Pull the @handle line; fall back to UserAvatar-Container-<handle>.
            let screen_name = '';
            const remaining = [];
            for (const l of lines) {
                if (!screen_name && l.startsWith('@')) {
                    screen_name = l.slice(1).split(/\\s/)[0];
                } else {
                    remaining.push(l);
                }
            }
            if (!screen_name) {
                const av = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
                const tid = av ? av.getAttribute('data-testid') || '' : '';
                if (tid.startsWith('UserAvatar-Container-')) {
                    screen_name = tid.slice('UserAvatar-Container-'.length);
                }
            }
            // First non-handle line is display name (may equal handle when the user hasn't set one).
            const name = remaining[0] || screen_name;
            // Lines past the display name form the bio.
            const bio = remaining.slice(1).join(' ').replace(/\\s+/g, ' ').trim();
            if (screen_name) {
                out.push({ screen_name, name, bio });
            }
        }
        return out;
    }`;
  return page.evaluate(script);
}
function normalizeScreenName(value) {
  return normalizeTwitterScreenName(value);
}
cli({
  site: "twitter",
  name: "followers",
  access: "read",
  description: "Get accounts following a Twitter/X user (defaults to the logged-in user when no user is given)",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "user",
      positional: true,
      type: "string",
      required: false,
      help: "Twitter/X handle (with or without @). Omit to fetch followers of the currently logged-in account."
    },
    { name: "limit", type: "int", default: 50, help: "Maximum number of follower rows to return (default 50). Must be a positive integer." }
  ],
  // `followers` (count) is NOT exposed: the SPA followers-list view does not
  // render it. Use `twitter profile <user>` for per-user follower counts.
  columns: ["screen_name", "name", "bio"],
  func: async (page, kwargs) => {
    const limit = kwargs.limit;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError("limit must be a positive integer");
    }
    const rawUser = String(kwargs.user ?? "").trim();
    let targetUser = normalizeScreenName(rawUser);
    if (rawUser && !targetUser) {
      throw new ArgumentError("twitter followers user must be a valid Twitter/X handle", "Example: opencli twitter followers @elonmusk --limit 100");
    }
    if (!targetUser) {
      // Trampoline idempotency: the no-user branch does two distinct unconditional
      // gotos (/home to detect self, then /<user>), which ping-pong forever — after
      // goto(/<user>) reinjects + replays the func, the leading goto(/home) bounces
      // back off the profile page and the cycle repeats. If we're already on the
      // self's profile page (/<user>, optionally /<user>/followers), recover the
      // handle from the URL and skip the /home self-detection navigation; the later
      // goto(/<user>) then becomes a no-op and the scrape proceeds.
      // normalizeScreenName rejects reserved paths (e.g. "home"), so sitting on
      // /home will not false-match. See adapter-hot-plug.md §10.21.
      const currentUrl = await page.getCurrentUrl().catch(() => "");
      const selfMatch = /^https?:\/\/(?:x|twitter|mobile\.twitter)\.com\/([A-Za-z0-9_]{1,15})(?:\/(?:followers|verified_followers))?(?:[?#].*)?$/.exec(currentUrl);
      const recoveredUser = selfMatch ? normalizeScreenName(selfMatch[1]) : "";
      if (recoveredUser) {
        targetUser = recoveredUser;
      } else {
        await page.goto("https://x.com/home");
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        const href = unwrapBrowserResult(await page.evaluate(`() => {
                const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
                return link ? link.getAttribute('href') : null;
            }`));
        if (!href || typeof href !== "string") {
          throw new AuthRequiredError("x.com", "Could not find logged-in user profile link. Are you logged in?");
        }
        targetUser = normalizeScreenName(href);
        if (!targetUser) {
          throw new AuthRequiredError("x.com", "Could not find logged-in user profile link. Are you logged in?");
        }
      }
    }
    if (!targetUser) {
      throw new ArgumentError("twitter followers user cannot be empty", "Example: opencli twitter followers @elonmusk --limit 100");
    }
    await page.goto(`https://x.com/${targetUser}`);
    await page.wait(3);
    const safeUser = JSON.stringify(targetUser);
    const clicked = await page.evaluate(`() => {
            const target = ${safeUser};
            const selectors = [
                'a[href="/' + target + '/followers"]',
                'a[href="/' + target + '/verified_followers"]',
            ];
            for (const sel of selectors) {
                const link = document.querySelector(sel);
                if (link) { link.click(); return true; }
            }
            return false;
        }`);
    if (!clicked) {
      throw selectorError("Twitter followers link", "Twitter may have changed the layout.");
    }
    await page.wait({ selector: '[data-testid="UserCell"]', timeout: 1e4 });
    const allFollowers = [];
    const seen = /* @__PURE__ */ new Set();
    let sameCount = 0;
    while (allFollowers.length < limit && sameCount < 3) {
      const rawFollowers = await extractFollowersFromDOM(page);
      if (!Array.isArray(rawFollowers)) {
        throw new CommandExecutionError("Twitter followers extraction returned malformed rows");
      }
      const followers = rawFollowers;
      const newFollowers = followers.filter((f) => !seen.has(f.screen_name));
      for (const f of newFollowers) {
        seen.add(f.screen_name);
        allFollowers.push(f);
      }
      if (newFollowers.length === 0) {
        sameCount++;
      } else {
        sameCount = 0;
      }
      if (allFollowers.length >= limit) break;
      await page.autoScroll({ times: 1, delayMs: 500 });
      await page.wait(2);
    }
    if (allFollowers.length === 0) {
      throw new EmptyResultError("twitter followers", `No followers found for @${targetUser}`);
    }
    return allFollowers.slice(0, limit);
  }
});
var __test__ = {
  extractFollowersFromDOM,
  normalizeScreenName
};
export {
  __test__
};
