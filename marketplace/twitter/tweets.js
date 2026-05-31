// ../browser-agent/opencli/clis/twitter/tweets.js
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
function normalizeTwitterGraphqlPayload(value) {
  const unwrapped = unwrapBrowserResult(value);
  if (unwrapped?.data && typeof unwrapped.data === "object") return unwrapped;
  if (unwrapped && typeof unwrapped === "object" && (Object.prototype.hasOwnProperty.call(unwrapped, "user") || Object.prototype.hasOwnProperty.call(unwrapped, "search_by_raw_query"))) {
    return { data: unwrapped };
  }
  return unwrapped;
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
function extractMedia(legacy) {
  const media = legacy?.extended_entities?.media || legacy?.entities?.media;
  if (!Array.isArray(media) || media.length === 0) {
    return { has_media: false, media_urls: [] };
  }
  const urls = [];
  for (const m of media) {
    if (!m) continue;
    if (m.type === "video" || m.type === "animated_gif") {
      const variants = m.video_info?.variants || [];
      const mp4 = variants.find((v) => v?.content_type === "video/mp4");
      const url = mp4?.url || m.media_url_https;
      if (url) urls.push(url);
    } else {
      if (m.media_url_https) urls.push(m.media_url_https);
    }
  }
  return { has_media: urls.length > 0, media_urls: urls };
}
function extractCard(tweet) {
  const cardLegacy = tweet?.card?.legacy;
  if (!cardLegacy) return null;
  const bindings = Array.isArray(cardLegacy.binding_values) ? cardLegacy.binding_values : [];
  const byKey = /* @__PURE__ */ new Map();
  for (const b of bindings) {
    if (b && typeof b.key === "string") byKey.set(b.key, b.value);
  }
  const str = (key) => {
    const v = byKey.get(key);
    return typeof v?.string_value === "string" && v.string_value.length > 0 ? v.string_value : void 0;
  };
  const img = (key) => {
    const v = byKey.get(key);
    const u = v?.image_value?.url;
    return typeof u === "string" && u.length > 0 ? u : void 0;
  };
  const title = str("title");
  const description = str("description");
  const domainBinding = str("domain");
  const cardUrlBinding = str("card_url");
  const image_url = img("thumbnail_image_large") || img("photo_image_full_size_large") || img("summary_photo_image_large");
  const urlEntities = Array.isArray(tweet?.legacy?.entities?.urls) ? tweet.legacy.entities.urls : [];
  const matchingEntity = cardUrlBinding ? urlEntities.find((entity) => entity?.url === cardUrlBinding || entity?.expanded_url === cardUrlBinding) : void 0;
  const matchedExpandedUrl = matchingEntity?.expanded_url;
  const url = typeof matchedExpandedUrl === "string" && matchedExpandedUrl.length > 0 ? matchedExpandedUrl : cardUrlBinding;
  let domain = domainBinding;
  if (!domain && url) {
    try {
      domain = new URL(url).hostname;
    } catch {
    }
  }
  if (!url && !title && !description) return null;
  const out = { name: cardLegacy.name };
  if (title) out.title = title;
  if (description) out.description = description;
  if (image_url) out.image_url = image_url;
  if (url) out.url = url;
  if (domain) out.domain = domain;
  return out;
}
function extractQuotedTweet(tweet) {
  const legacy = tweet?.legacy;
  if (!legacy?.is_quote_status) return null;
  const q = tweet?.quoted_status_result?.result ?? tweet?.legacy?.quoted_status_result?.result;
  if (!q) return null;
  const qTw = q.tweet || q;
  if (!qTw || typeof qTw !== "object") return null;
  const qLegacy = qTw.legacy && typeof qTw.legacy === "object" ? qTw.legacy : {};
  if (typeof qTw.rest_id !== "string" || !qTw.rest_id.trim()) return null;
  const qUser = qTw.core?.user_results?.result;
  const qLegacyScreenName = qUser?.legacy?.screen_name;
  const qCoreScreenName = qUser?.core?.screen_name;
  const qScreenName = typeof qLegacyScreenName === "string" && qLegacyScreenName.trim() ? qLegacyScreenName.trim() : typeof qCoreScreenName === "string" && qCoreScreenName.trim() ? qCoreScreenName.trim() : "";
  if (!SCREEN_NAME_PATTERN.test(qScreenName)) return null;
  const qLegacyDisplayName = qUser?.legacy?.name;
  const qCoreDisplayName = qUser?.core?.name;
  const qDisplayName = typeof qLegacyDisplayName === "string" ? qLegacyDisplayName : typeof qCoreDisplayName === "string" ? qCoreDisplayName : "";
  const qNoteText = qTw.note_tweet?.note_tweet_results?.result?.text;
  const qText = typeof qNoteText === "string" && qNoteText.length > 0 ? qNoteText : typeof qLegacy.full_text === "string" ? qLegacy.full_text : "";
  const qMedia = extractMedia(qLegacy);
  const qCard = extractCard(qTw);
  if (!qText && !qMedia.has_media && !qCard) return null;
  const out = {
    id: qTw.rest_id,
    author: qScreenName,
    name: qDisplayName,
    text: qText,
    created_at: typeof qLegacy.created_at === "string" ? qLegacy.created_at : "",
    url: `https://x.com/${qScreenName}/status/${qTw.rest_id}`,
    has_media: qMedia.has_media,
    media_urls: qMedia.media_urls
  };
  if (qCard) out.card = qCard;
  return out;
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
function computeEngagementScore(row) {
  if (!row || typeof row !== "object") return 0;
  const num = (key) => {
    const raw = row[key];
    if (raw === void 0 || raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  const score = num("likes") * ENGAGEMENT_WEIGHTS.likes + num("retweets") * ENGAGEMENT_WEIGHTS.retweets + num("replies") * ENGAGEMENT_WEIGHTS.replies + num("bookmarks") * ENGAGEMENT_WEIGHTS.bookmarks + Math.log10(num("views") + 1) * ENGAGEMENT_WEIGHTS.viewsLog;
  return Math.round(score * 100) / 100;
}
function applyTopByEngagement(rows, topN) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const n = Number(topN);
  if (!Number.isFinite(n) || n <= 0) return rows;
  return rows.map((row, idx) => ({ row, idx, score: computeEngagementScore(row) })).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, Math.floor(n)).map((entry) => entry.row);
}

// ../browser-agent/opencli/clis/twitter/tweets.js
var USER_TWEETS_QUERY_ID = "lrMzG9qPQHpqJdP3AbM-bQ";
var USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ";
var MAX_PAGINATION_PAGES = 100;
var USER_TWEETS_FEATURES = {
  rweb_video_screen_enabled: true,
  rweb_cashtags_enabled: true,
  payments_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
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
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false
};
var USER_TWEETS_FIELD_TOGGLES = {
  withPayments: true,
  withAuxiliaryUserLabels: true,
  withArticleRichContentState: true,
  withArticlePlainText: true,
  withArticleSummaryText: true,
  withArticleVoiceOver: true,
  withGrokAnalyze: true,
  withDisallowedReplyControls: true
};
var USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
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
};
var USER_BY_SCREEN_NAME_FIELD_TOGGLES = {
  withPayments: true,
  withAuxiliaryUserLabels: true
};
var USER_TWEETS_OPERATION = {
  queryId: USER_TWEETS_QUERY_ID,
  features: USER_TWEETS_FEATURES,
  fieldToggles: USER_TWEETS_FIELD_TOGGLES
};
var USER_BY_SCREEN_NAME_OPERATION = {
  queryId: USER_BY_SCREEN_NAME_QUERY_ID,
  features: USER_BY_SCREEN_NAME_FEATURES,
  fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES
};
function normalizeUserTweetsOperation(operation) {
  if (typeof operation === "string") {
    return { queryId: operation, features: USER_TWEETS_FEATURES, fieldToggles: USER_TWEETS_FIELD_TOGGLES };
  }
  return {
    queryId: operation?.queryId || USER_TWEETS_QUERY_ID,
    features: operation?.features || USER_TWEETS_FEATURES,
    fieldToggles: operation?.fieldToggles || USER_TWEETS_FIELD_TOGGLES
  };
}
function normalizeUserByScreenNameOperation(operation) {
  if (typeof operation === "string") {
    return { queryId: operation, features: USER_BY_SCREEN_NAME_FEATURES, fieldToggles: USER_BY_SCREEN_NAME_FIELD_TOGGLES };
  }
  return {
    queryId: operation?.queryId || USER_BY_SCREEN_NAME_QUERY_ID,
    features: operation?.features || USER_BY_SCREEN_NAME_FEATURES,
    fieldToggles: operation?.fieldToggles || USER_BY_SCREEN_NAME_FIELD_TOGGLES
  };
}
function appendGraphqlParams(path2, variables, operation) {
  const fieldToggles = operation.fieldToggles || {};
  const params = [
    `variables=${encodeURIComponent(JSON.stringify(variables))}`,
    `features=${encodeURIComponent(JSON.stringify(operation.features || {}))}`
  ];
  if (Object.keys(fieldToggles).length > 0) {
    params.push(`fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`);
  }
  return `${path2}?${params.join("&")}`;
}
function buildUserTweetsUrl(operation, userId, count, cursor) {
  const normalized = normalizeUserTweetsOperation(operation);
  const vars = {
    userId,
    count,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true
  };
  if (cursor) vars.cursor = cursor;
  return appendGraphqlParams(`/i/api/graphql/${normalized.queryId}/UserTweets`, vars, normalized);
}
function buildUserByScreenNameUrl(operation, screenName) {
  const normalized = normalizeUserByScreenNameOperation(operation);
  const vars = { screen_name: screenName, withSafetyModeUserFields: true };
  return appendGraphqlParams(`/i/api/graphql/${normalized.queryId}/UserByScreenName`, vars, normalized);
}
function extractTweet(result, seen) {
  if (!result) return null;
  const tw = result.__typename === "TweetWithVisibilityResults" && result.tweet ? result.tweet : result.tweet || result;
  const legacy = tw.legacy || {};
  if (!tw.rest_id || seen.has(tw.rest_id)) return null;
  seen.add(tw.rest_id);
  const user = tw.core?.user_results?.result;
  const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "unknown";
  const displayName = user?.legacy?.name || user?.core?.name || "";
  const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
  const isRetweet = Boolean(legacy.retweeted_status_result || legacy.full_text?.startsWith("RT @"));
  return {
    id: tw.rest_id,
    author: screenName,
    name: displayName,
    text: noteText || legacy.full_text || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: Number(tw.views?.count) || 0,
    is_retweet: isRetweet,
    created_at: legacy.created_at || "",
    url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    ...extractMedia(legacy),
    quoted_tweet: extractQuotedTweet(tw)
  };
}
function parseUserTweets(data, seen) {
  const tweets = [];
  let nextCursor = null;
  const result = data?.data?.user?.result || {};
  const instructionSets = [
    result.timeline_v2?.timeline?.instructions,
    result.timeline?.timeline?.instructions
  ].filter(Array.isArray);
  const instructions = instructionSets.flat();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "TimelinePinEntry") return;
    if (value.tweet_results?.result) {
      const tweet = extractTweet(value.tweet_results.result, seen);
      if (tweet) tweets.push(tweet);
    }
    if ((value.entryType === "TimelineTimelineCursor" || value.__typename === "TimelineTimelineCursor") && (value.cursorType === "Bottom" || value.cursorType === "ShowMore") && value.value) {
      nextCursor = value.value;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(instructions);
  return { tweets, nextCursor };
}
cli({
  site: "twitter",
  name: "tweets",
  access: "read",
  description: "Fetch a Twitter user's most recent tweets (chronological, excludes pinned; defaults to the logged-in user when no username is given)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "username", type: "string", positional: true, help: "Twitter screen name (with or without @). Defaults to the logged-in user when omitted." },
    { name: "limit", type: "int", default: 20, help: "Max tweets to return" },
    { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the tweets by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps the chronological ordering." }
  ],
  columns: ["id", "author", "created_at", "is_retweet", "text", "likes", "retweets", "replies", "views", "url", "has_media", "media_urls", "quoted_tweet"],
  func: async (page, kwargs) => {
    const limit = Math.max(1, Math.min(200, kwargs.limit || 20));
    const rawUsername = String(kwargs.username ?? "").trim();
    let username = normalizeTwitterScreenName(rawUsername);
    if (rawUsername && !username) {
      throw new ArgumentError("twitter tweets username must be a valid Twitter/X handle", "Example: opencli twitter tweets @jack --limit 20");
    }
    if (!username) {
      await page.goto("https://x.com/home");
      await page.wait({ selector: '[data-testid="primaryColumn"]' });
      const href = unwrapBrowserResult(await page.evaluate(`() => {
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return link ? link.getAttribute('href') : null;
      }`));
      if (!href || typeof href !== "string")
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      username = normalizeTwitterScreenName(href);
      if (!username) {
        throw new AuthRequiredError("x.com", "Could not detect logged-in user. Are you logged in?");
      }
    }
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userTweetsOperation = await resolveTwitterOperationMetadata(page, "UserTweets", USER_TWEETS_OPERATION);
    const userByScreenNameOperation = await resolveTwitterOperationMetadata(page, "UserByScreenName", USER_BY_SCREEN_NAME_OPERATION);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const ubsUrl = buildUserByScreenNameUrl(userByScreenNameOperation, username);
    const userId = unwrapBrowserResult(await page.evaluate(`async () => {
      const resp = await fetch("${ubsUrl}", { headers: ${headers}, credentials: 'include' });
      if (!resp.ok) return null;
      const d = await resp.json();
      return d?.data?.user?.result?.rest_id || null;
    }`));
    if (!userId) throw new CommandExecutionError(`Could not resolve @${username}`);
    const seen = /* @__PURE__ */ new Set();
    const all = [];
    let cursor = null;
    for (let i = 0; i < MAX_PAGINATION_PAGES && all.length < limit; i++) {
      const fetchCount = Math.min(100, limit - all.length + 10);
      const url = buildUserTweetsUrl(userTweetsOperation, userId, fetchCount, cursor);
      const data = normalizeTwitterGraphqlPayload(await page.evaluate(`async () => {
        const r = await fetch("${url}", { headers: ${headers}, credentials: 'include' });
        return r.ok ? await r.json() : { error: r.status };
      }`));
      if (data?.error) {
        if (all.length === 0) throw new CommandExecutionError(`HTTP ${data.error}: UserTweets fetch failed — queryId may have expired`);
        break;
      }
      const { tweets, nextCursor } = parseUserTweets(data, seen);
      all.push(...tweets);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (all.length === 0) throw new EmptyResultError(`@${username} has no recent tweets`, "Account may be private or suspended");
    const trimmed = all.slice(0, limit);
    return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
  }
});
var __test__ = {
  sanitizeQueryId,
  buildUserTweetsUrl,
  buildUserByScreenNameUrl,
  extractTweet,
  parseUserTweets
};
export {
  __test__
};
