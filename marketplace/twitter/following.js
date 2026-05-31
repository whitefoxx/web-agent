// ../browser-agent/opencli/clis/twitter/following.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
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
function isEmptyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}
function looksLikePrivateTwitterTimeline(data) {
  const result = data?.data?.user?.result;
  if (!result || typeof result !== "object") return false;
  return Boolean(isEmptyObject(result.timeline) || isEmptyObject(result.timeline_v2?.timeline));
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

// ../browser-agent/opencli/clis/twitter/following.js
var FOLLOWING_QUERY_ID = "F42cDX8PDFxkbjjq6JrM2w";
var USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ";
var MAX_PAGINATION_PAGES = 100;
var FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false
};
function buildFollowingUrl(queryId, userId, count, cursor) {
  const vars = {
    userId,
    count,
    includePromotedContent: false,
    withClientEventToken: false,
    withBirdwatchNotes: false,
    withVoice: true,
    withV2Timeline: true
  };
  if (cursor)
    vars.cursor = cursor;
  return `/i/api/graphql/${queryId}/Following?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}
function buildUserByScreenNameUrl(queryId, screenName) {
  const vars = JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true });
  const feats = JSON.stringify({
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
    responsive_web_graphql_timeline_navigation_enabled: true
  });
  return `/i/api/graphql/${queryId}/UserByScreenName?variables=${encodeURIComponent(vars)}&features=${encodeURIComponent(feats)}`;
}
function extractUser(result) {
  if (!result || result.__typename !== "User")
    return null;
  const core = result.core || {};
  const legacy = result.legacy || {};
  return {
    screen_name: core.screen_name || legacy.screen_name || "unknown",
    name: core.name || legacy.name || "unknown",
    bio: legacy.description || result.profile_bio?.description || "",
    followers: legacy.followers_count || legacy.normal_followers_count || 0
  };
}
function parseFollowing(data) {
  const users = [];
  let nextCursor = null;
  const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || data?.data?.user?.result?.timeline?.timeline?.instructions || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const content = entry.content;
      if (content?.entryType === "TimelineTimelineCursor" || content?.__typename === "TimelineTimelineCursor") {
        if (content.cursorType === "Bottom" || content.cursorType === "ShowMore")
          nextCursor = content.value;
        continue;
      }
      if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
        nextCursor = content?.value || content?.itemContent?.value || nextCursor;
        continue;
      }
      if (entry.entryId?.startsWith("user-")) {
        const user = extractUser(content?.itemContent?.user_results?.result);
        if (user)
          users.push(user);
      }
    }
  }
  return { users, nextCursor };
}
function normalizeScreenName(value) {
  return normalizeTwitterScreenName(value);
}
cli({
  site: "twitter",
  name: "following",
  access: "read",
  description: "Get accounts a Twitter/X user is following (defaults to the logged-in user when no user is given)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "user",
      positional: true,
      type: "string",
      required: false,
      help: "Twitter/X handle (with or without @). Omit to fetch the accounts the currently logged-in user follows."
    },
    { name: "limit", type: "int", default: 50, help: "Maximum number of following rows to return (default 50). Must be a positive integer." }
  ],
  columns: ["screen_name", "name", "bio", "followers"],
  func: async (page, kwargs) => {
    const limit = kwargs.limit === void 0 || kwargs.limit === null ? 50 : Number(kwargs.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError("twitter following --limit must be a positive integer", "Example: opencli twitter following @elonmusk --limit 200");
    }
    const rawUser = String(kwargs.user ?? "").trim();
    let targetUser = normalizeScreenName(rawUser);
    if (rawUser && !targetUser) {
      throw new ArgumentError("twitter following user must be a valid Twitter/X handle", "Example: opencli twitter following @elonmusk --limit 200");
    }
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    if (!targetUser) {
      await page.goto("https://x.com/home");
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const href = unwrapBrowserResult(await page.evaluate(`() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      }`));
      if (!href || typeof href !== "string")
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      targetUser = normalizeScreenName(href);
      if (!targetUser)
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
    }
    if (!targetUser) {
      throw new ArgumentError("twitter following user cannot be empty", "Example: opencli twitter following @elonmusk --limit 200");
    }
    const followingQueryId = await resolveTwitterQueryId(page, "Following", FOLLOWING_QUERY_ID);
    const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID);
    const headers = {
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    };
    const userLookup = unwrapBrowserResult(await page.evaluate(async (url, headers2) => {
      const resp = await fetch(url, { headers: headers2, credentials: "include" });
      if (!resp.ok) return { error: resp.status };
      const d = await resp.json();
      return { userId: d.data?.user?.result?.rest_id || null };
    }, buildUserByScreenNameUrl(userByScreenNameQueryId, targetUser), headers));
    if (userLookup?.error === 401 || userLookup?.error === 403) {
      throw new AuthRequiredError("x.com", `Twitter user lookup failed (HTTP ${userLookup.error})`);
    }
    if (userLookup?.error) {
      throw new CommandExecutionError(`HTTP ${userLookup.error}: Failed to resolve Twitter user @${targetUser}`);
    }
    const userId = userLookup?.userId || null;
    if (!userId)
      throw new CommandExecutionError(`Could not find user @${targetUser}`);
    const allUsers = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    let lastRawResponse = null;
    for (let i = 0; i < MAX_PAGINATION_PAGES && allUsers.length < limit; i++) {
      const fetchCount = Math.min(50, limit - allUsers.length + 10);
      const apiUrl = buildFollowingUrl(followingQueryId, userId, fetchCount, cursor);
      const data = unwrapBrowserResult(await page.evaluate(async (url, headers2) => {
        const r = await fetch(url, { headers: headers2, credentials: "include" });
        return r.ok ? await r.json() : { error: r.status };
      }, apiUrl, headers));
      if (data?.error) {
        if (data.error === 401 || data.error === 403)
          throw new AuthRequiredError("x.com", `Twitter following request failed (HTTP ${data.error})`);
        throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch following list. queryId may have expired.`);
      }
      lastRawResponse = data;
      const { users, nextCursor } = parseFollowing(data);
      for (const u of users) {
        if (!seen.has(u.screen_name)) {
          seen.add(u.screen_name);
          allUsers.push(u);
        }
      }
      if (!nextCursor || nextCursor === cursor)
        break;
      cursor = nextCursor;
    }
    if (allUsers.length === 0) {
      if (looksLikePrivateTwitterTimeline(lastRawResponse)) {
        throw new EmptyResultError("twitter following", `No following data returned for @${targetUser} (the target account may have set their following list to private)`);
      }
      throw new EmptyResultError("twitter following", `No following accounts found for @${targetUser}`);
    }
    return allUsers.slice(0, limit);
  }
});
var __test__ = {
  sanitizeQueryId,
  buildFollowingUrl,
  buildUserByScreenNameUrl,
  extractUser,
  normalizeScreenName,
  parseFollowing
};
export {
  __test__
};
