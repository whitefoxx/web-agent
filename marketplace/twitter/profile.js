// ../browser-agent/opencli/clis/twitter/profile.js
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/twitter/shared.js

var QUERY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
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
function sanitizeQueryId(resolved, fallbackId) {
  return typeof resolved === "string" && QUERY_ID_PATTERN.test(resolved) ? resolved : fallbackId;
}
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
function normalizeOperationFallback(fallback) {
  if (typeof fallback === "string") return { queryId: fallback, features: {}, fieldToggles: {} };
  return {
    queryId: fallback?.queryId || null,
    features: fallback?.features || {},
    fieldToggles: fallback?.fieldToggles || {}
  };
}
function unwrapBrowserResult(value) {
  if (value && typeof value === "object" && typeof value.session === "string" && Object.prototype.hasOwnProperty.call(value, "data")) {
    return value.data;
  }
  return value;
}
function sanitizeTwitterOperationMetadata(resolved, fallback) {
  const value = unwrapBrowserResult(resolved);
  const normalizedFallback = normalizeOperationFallback(fallback);
  return {
    queryId: sanitizeQueryId(value?.queryId, normalizedFallback.queryId),
    features: value?.features && typeof value.features === "object" && Object.keys(value.features).length > 0 ? value.features : normalizedFallback.features,
    fieldToggles: value?.fieldToggles && typeof value.fieldToggles === "object" && Object.keys(value.fieldToggles).length > 0 ? value.fieldToggles : normalizedFallback.fieldToggles
  };
}
async function resolveTwitterOperationMetadata(page, operationName, fallback) {
  const resolved = await page.evaluate(`async () => {
    const operationName = ${JSON.stringify(operationName)};
    const keysToFlags = (keys) => Object.fromEntries((keys || []).map((key) => [key, true]));
    const quotedKeys = (source) => source
      ? Array.from(source.matchAll(/"([^"]+)"/g)).map((match) => match[1])
      : [];
    const parseOperation = (text) => {
      const marker = 'operationName:"' + operationName + '"';
      const index = text.indexOf(marker);
      if (index < 0) return null;
      const start = Math.max(0, text.lastIndexOf('e.exports=', index));
      const endMarker = text.indexOf('}}}', index);
      const snippet = text.slice(start, endMarker > index ? endMarker + 3 : index + 2500);
      const queryId = snippet.match(/queryId:"([A-Za-z0-9_-]+)"/)?.[1] || null;
      if (!queryId) return null;
      return {
        queryId,
        features: keysToFlags(quotedKeys(snippet.match(/featureSwitches:\\[([^\\]]*)\\]/)?.[1])),
        fieldToggles: keysToFlags(quotedKeys(snippet.match(/fieldToggles:\\[([^\\]]*)\\]/)?.[1])),
      };
    };
    try {
      const scripts = Array.from(document.scripts)
        .map(s => s.src)
        .filter(Boolean)
        .concat(performance.getEntriesByType('resource')
          .map(r => r.name)
          .filter(r => r.includes('client-web') && r.endsWith('.js')));
      const uniqueScripts = Array.from(new Set(scripts));
      for (const scriptUrl of uniqueScripts.slice(-30)) {
        try {
          const text = await (await fetch(scriptUrl)).text();
          const operation = parseOperation(text);
          if (operation) return operation;
        } catch {}
      }
    } catch {}
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json', { signal: controller.signal });
      clearTimeout(timeout);
      if (ghResp.ok) {
        const data = await ghResp.json();
        const entry = data?.[operationName];
        if (entry && entry.queryId) {
          return {
            queryId: entry.queryId,
            features: keysToFlags(entry.featureSwitches),
            fieldToggles: keysToFlags(entry.fieldToggles),
          };
        }
      }
    } catch {
      clearTimeout(timeout);
    }
    return null;
  }`);
  return sanitizeTwitterOperationMetadata(resolved, fallback);
}
async function resolveTwitterQueryId(page, operationName, fallbackId) {
  const operation = await resolveTwitterOperationMetadata(page, operationName, fallbackId);
  return operation.queryId;
}

// ../browser-agent/opencli/clis/twitter/utils.js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

var TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
var MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
var ENGAGEMENT_WEIGHTS = Object.freeze({
  likes: 1,
  retweets: 3,
  replies: 2,
  bookmarks: 5,
  viewsLog: 0.5
});

// ../browser-agent/opencli/clis/twitter/profile.js
var USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ";
function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function stringField(value) {
  return typeof value === "string" ? value : "";
}
function mapTwitterProfileResult(result, screenName) {
  if (!isPlainObject(result)) {
    throw new CommandExecutionError(`Twitter profile response for @${screenName} is malformed`);
  }
  const hasLegacy = isPlainObject(result.legacy);
  const hasCore = isPlainObject(result.core);
  if (!hasLegacy && !hasCore) {
    throw new CommandExecutionError(`Twitter profile response for @${screenName} is missing profile fields`);
  }
  const legacy = hasLegacy ? result.legacy : {};
  const core = hasCore ? result.core : {};
  if (!stringField(core.screen_name) && !stringField(legacy.screen_name) && !stringField(core.name) && !stringField(legacy.name) && !stringField(core.created_at) && !stringField(legacy.created_at)) {
    throw new CommandExecutionError(`Twitter profile response for @${screenName} is missing profile identity fields`);
  }
  const location = isPlainObject(result.location) ? result.location : {};
  const expandedUrl = legacy.entities?.url?.urls?.[0]?.expanded_url || "";
  return [{
    screen_name: stringField(core.screen_name) || stringField(legacy.screen_name) || screenName,
    name: stringField(core.name) || stringField(legacy.name),
    bio: stringField(legacy.description),
    location: stringField(location.location) || stringField(legacy.location),
    url: stringField(expandedUrl),
    followers: legacy.followers_count || 0,
    following: legacy.friends_count || 0,
    tweets: legacy.statuses_count || 0,
    likes: legacy.favourites_count || 0,
    verified: Boolean(result.is_blue_verified || legacy.verified),
    created_at: stringField(core.created_at) || stringField(legacy.created_at)
  }];
}
cli({
  site: "twitter",
  name: "profile",
  access: "read",
  description: "Fetch a Twitter user profile — bio, stats, etc. (defaults to the logged-in user when no username is given)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "username", type: "string", positional: true, help: "Twitter screen name (with or without @). Defaults to the logged-in user when omitted." }
  ],
  columns: ["screen_name", "name", "bio", "location", "url", "followers", "following", "tweets", "likes", "verified", "created_at"],
  func: async (page, kwargs) => {
    const rawUsername = String(kwargs.username ?? "").trim();
    let username = normalizeTwitterScreenName(rawUsername);
    if (rawUsername && !username) {
      throw new ArgumentError("twitter profile username must be a valid Twitter/X handle", "Example: opencli twitter profile @jack");
    }
    if (!username) {
      // Trampoline idempotency: hot-plug funcs re-execute from the top after a
      // page.goto() navigation. The no-username path does TWO distinct gotos —
      // x.com/home (to detect the logged-in handle) then x.com/<handle> (the
      // final scrape page). On the re-execution that lands on the profile page,
      // skip the leading /home detection by recovering <handle> from the current
      // URL; otherwise goto("x.com/home") would bounce us off the profile and
      // ping-pong forever. normalizeTwitterScreenName() accepts a full URL and
      // returns "" for reserved paths (e.g. /home), so a replay mid-block at
      // /home falls through to normal detection. See adapter-hot-plug.md §10.21.
      const currentUsername = normalizeTwitterScreenName(await page.getCurrentUrl().catch(() => ""));
      if (currentUsername) {
        username = currentUsername;
      } else {
        await page.goto("https://x.com/home");
        await page.wait({ selector: '[data-testid="primaryColumn"]' });
        const href = unwrapBrowserResult(await page.evaluate(`() => {
          const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          return link ? link.getAttribute('href') : null;
        }`));
        if (!href || typeof href !== "string")
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
        username = normalizeTwitterScreenName(href);
        if (!username)
          throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
    }
    await page.goto(`https://x.com/${username}`);
    await page.wait(3);
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const queryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID);
    const rawResult = unwrapBrowserResult(await page.evaluate(`
      async () => {
        const screenName = "${username}";
        const ct0 = ${JSON.stringify(ct0)};

        const bearer = ${JSON.stringify(TWITTER_BEARER_TOKEN)};
        const headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes'
        };

        const variables = JSON.stringify({
          screen_name: screenName,
          withSafetyModeUserFields: true,
        });
        const features = JSON.stringify({
          hidden_profile_subscriptions_enabled: true,
          rweb_tipjar_consumption_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
          subscriptions_verification_info_is_identity_verified_enabled: true,
          subscriptions_verification_info_verified_since_enabled: true,
          highlights_tweets_tab_ui_enabled: true,
          responsive_web_twitter_article_notes_tab_enabled: true,
          subscriptions_feature_can_gift_premium: true,
          creator_subscriptions_tweet_preview_api_enabled: true,
          responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
          responsive_web_graphql_timeline_navigation_enabled: true,
        });

        const url = '/i/api/graphql/' + ${JSON.stringify(queryId)} + '/UserByScreenName?variables='
          + encodeURIComponent(variables)
          + '&features=' + encodeURIComponent(features);

        let resp;
        try {
          resp = await fetch(url, {headers, credentials: 'include'});
        } catch (error) {
          return {ok: false, error: 'Twitter profile request failed: ' + String(error && error.message || error)};
        }
        if (!resp.ok) {
          return {
            ok: false,
            auth: resp.status === 401 || resp.status === 403,
            error: 'HTTP ' + resp.status,
            hint: 'User may not exist, auth may be required, or queryId expired'
          };
        }
        let d;
        try {
          d = await resp.json();
        } catch (error) {
          return {ok: false, error: 'Twitter profile response was not JSON: ' + String(error && error.message || error)};
        }

        const result = d.data?.user?.result;
        if (!result) return {ok: false, notFound: true, error: 'User @' + screenName + ' not found'};
        return {ok: true, result};
      }
    `));
    if (!isPlainObject(rawResult)) {
      throw new CommandExecutionError("Twitter profile response payload is malformed");
    }
    if (!rawResult.ok) {
      const message = rawResult.error + (rawResult.hint ? ` (${rawResult.hint})` : "");
      if (rawResult.auth) {
        throw new AuthRequiredError("x.com", message);
      }
      if (rawResult.notFound) {
        throw new EmptyResultError("twitter profile", message);
      }
      throw new CommandExecutionError(message);
    }
    return mapTwitterProfileResult(rawResult.result, username);
  }
});
var __test__ = { mapTwitterProfileResult };
export {
  __test__,
  mapTwitterProfileResult
};
