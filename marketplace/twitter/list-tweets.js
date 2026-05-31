// ../browser-agent/opencli/clis/twitter/list-tweets.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/twitter/shared.js

var SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
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

// ../browser-agent/opencli/clis/twitter/list-tweets.js
var LIST_TWEETS_QUERY_ID = "RlZzktZY_9wJynoepm8ZsA";
var OPERATION_NAME = "ListLatestTweetsTimeline";
var MAX_PAGINATION_PAGES = 100;
var FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
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
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false
};
function buildUrl(queryId, listId, count, cursor) {
  const vars = { listId: String(listId), count };
  if (cursor)
    vars.cursor = cursor;
  return `/i/api/graphql/${queryId}/${OPERATION_NAME}?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}
function extractTimelineTweet(result, seen) {
  if (!result)
    return null;
  const tw = result.tweet || result;
  const legacy = tw.legacy || {};
  if (!tw.rest_id || seen.has(tw.rest_id))
    return null;
  seen.add(tw.rest_id);
  const user = tw.core?.user_results?.result;
  const screenName = user?.legacy?.screen_name || user?.core?.screen_name || "unknown";
  const displayName = user?.legacy?.name || user?.core?.name || "";
  const bio = user?.legacy?.description || "";
  const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
  return {
    id: tw.rest_id,
    author: screenName,
    name: displayName,
    bio,
    text: noteText || legacy.full_text || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    created_at: legacy.created_at || "",
    url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    ...extractMedia(legacy),
    card: extractCard(tw),
    quoted_tweet: extractQuotedTweet(tw)
  };
}
function parseListTimeline(data, seen) {
  const tweets = [];
  let nextCursor = null;
  const instructions = data?.data?.list?.tweets_timeline?.timeline?.instructions || [];
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
      const direct = extractTimelineTweet(content?.itemContent?.tweet_results?.result, seen);
      if (direct) {
        tweets.push(direct);
        continue;
      }
      for (const item of content?.items || []) {
        const nested = extractTimelineTweet(item.item?.itemContent?.tweet_results?.result, seen);
        if (nested)
          tweets.push(nested);
      }
    }
  }
  return { tweets, nextCursor };
}
cli({
  site: "twitter",
  name: "list-tweets",
  access: "read",
  description: "Fetch tweets from a Twitter/X list timeline",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of a Twitter/X list (e.g. from `opencli twitter lists`)" },
    { name: "limit", type: "int", default: 50 },
    { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the list timeline by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps the list's native (recency) ordering." }
  ],
  columns: ["id", "author", "bio", "text", "likes", "retweets", "replies", "created_at", "url", "has_media", "media_urls", "card", "quoted_tweet"],
  func: async (page, kwargs) => {
    const listId = String(kwargs.listId || "").trim();
    if (!listId || !/^\d+$/.test(listId)) {
      throw new CommandExecutionError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected a numeric ID (see \`opencli twitter lists\`).`);
    }
    const limit = kwargs.limit || 50;
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const unwrap = (v) => v && typeof v === "object" && "session" in v && "data" in v ? v.data : v;
    const queryIdRaw = await page.evaluate(`async () => {
            try {
                const ghResp = await fetch('https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json');
                if (ghResp.ok) {
                    const data = await ghResp.json();
                    const entry = data['${OPERATION_NAME}'];
                    if (entry && entry.queryId) return entry.queryId;
                }
            } catch {}
            try {
                const scripts = performance.getEntriesByType('resource')
                    .filter(r => r.name.includes('client-web') && r.name.endsWith('.js'))
                    .map(r => r.name);
                for (const scriptUrl of scripts.slice(0, 15)) {
                    try {
                        const text = await (await fetch(scriptUrl)).text();
                        const re = /queryId:"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:"${OPERATION_NAME}"/;
                        const m = text.match(re);
                        if (m) return m[1];
                    } catch {}
                }
            } catch {}
            return null;
        }`);
    const queryId = unwrap(queryIdRaw) || LIST_TWEETS_QUERY_ID;
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const allTweets = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    for (let i = 0; i < MAX_PAGINATION_PAGES && allTweets.length < limit; i++) {
      const fetchCount = Math.min(100, limit - allTweets.length + 10);
      const apiUrl = buildUrl(queryId, listId, fetchCount, cursor);
      const data = await page.evaluate(`async () => {
                const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
                return r.ok ? await r.json() : { error: r.status };
            }`);
      if (data?.error) {
        if (allTweets.length === 0)
          throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch list timeline. queryId may have expired or list may be private.`);
        break;
      }
      const { tweets, nextCursor } = parseListTimeline(data, seen);
      allTweets.push(...tweets);
      if (!nextCursor || nextCursor === cursor || tweets.length === 0)
        break;
      cursor = nextCursor;
    }
    const trimmed = allTweets.slice(0, limit);
    return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
  }
});
export {
  extractTimelineTweet,
  parseListTimeline
};
