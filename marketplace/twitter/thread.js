// ../browser-agent/opencli/clis/twitter/thread.js
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

// ../browser-agent/opencli/clis/twitter/thread.js
var TWEET_DETAIL_QUERY_ID = "nBS-WpgA6ZG0CyNHD517JQ";
var FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true
};
var FIELD_TOGGLES = { withArticleRichContentState: true, withArticlePlainText: false };
function buildTweetDetailUrl(tweetId, cursor) {
  const vars = {
    focalTweetId: tweetId,
    referrer: "tweet",
    with_rux_injections: false,
    includePromotedContent: false,
    rankingMode: "Recency",
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true
  };
  if (cursor)
    vars.cursor = cursor;
  return `/i/api/graphql/${TWEET_DETAIL_QUERY_ID}/TweetDetail?variables=${encodeURIComponent(JSON.stringify(vars))}&features=${encodeURIComponent(JSON.stringify(FEATURES))}&fieldToggles=${encodeURIComponent(JSON.stringify(FIELD_TOGGLES))}`;
}
function extractTweet(r, seen) {
  if (!r)
    return null;
  const tw = r.tweet || r;
  const l = tw.legacy || {};
  if (!tw.rest_id || seen.has(tw.rest_id))
    return null;
  seen.add(tw.rest_id);
  const u = tw.core?.user_results?.result;
  const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
  const screenName = u?.legacy?.screen_name || u?.core?.screen_name || "unknown";
  const bio = u?.legacy?.description || "";
  return {
    id: tw.rest_id,
    author: screenName,
    bio,
    text: noteText || l.full_text || "",
    likes: l.favorite_count || 0,
    retweets: l.retweet_count || 0,
    in_reply_to: l.in_reply_to_status_id_str || void 0,
    created_at: l.created_at,
    url: `https://x.com/${screenName}/status/${tw.rest_id}`,
    ...extractMedia(l),
    card: extractCard(tw),
    quoted_tweet: extractQuotedTweet(tw)
  };
}
function parseTweetDetail(data, seen) {
  const tweets = [];
  let nextCursor = null;
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || data?.data?.tweetResult?.result?.timeline?.instructions || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      const c = entry.content;
      if (c?.entryType === "TimelineTimelineCursor" || c?.__typename === "TimelineTimelineCursor") {
        if (c.cursorType === "Bottom" || c.cursorType === "ShowMore")
          nextCursor = c.value;
        continue;
      }
      if (entry.entryId?.startsWith("cursor-bottom-") || entry.entryId?.startsWith("cursor-showMore-")) {
        nextCursor = c?.itemContent?.value || c?.value || nextCursor;
        continue;
      }
      const tw = extractTweet(c?.itemContent?.tweet_results?.result, seen);
      if (tw)
        tweets.push(tw);
      for (const item of c?.items || []) {
        const nested = extractTweet(item.item?.itemContent?.tweet_results?.result, seen);
        if (nested)
          tweets.push(nested);
      }
    }
  }
  return { tweets, nextCursor };
}
var __test__ = {
  parseTweetDetail
};
cli({
  site: "twitter",
  name: "thread",
  access: "read",
  description: "Get a tweet thread (original + all replies)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "tweet-id", positional: true, type: "string", required: true, help: "Tweet numeric ID (e.g. 1234567890) or full status URL" },
    { name: "limit", type: "int", default: 50 },
    { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the thread by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps the conversation's structural ordering." }
  ],
  columns: ["id", "author", "bio", "text", "likes", "retweets", "url", "has_media", "media_urls", "card", "quoted_tweet"],
  func: async (page, kwargs) => {
    let tweetId = kwargs["tweet-id"];
    const urlMatch = tweetId.match(/\/status\/(\d+)/);
    if (urlMatch)
      tweetId = urlMatch[1];
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const allTweets = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const apiUrl = buildTweetDetailUrl(tweetId, cursor);
      const data = await page.evaluate(`async () => {
        const r = await fetch("${apiUrl}", { headers: ${headers}, credentials: 'include' });
        return r.ok ? await r.json() : { error: r.status };
      }`);
      if (data?.error) {
        if (allTweets.length === 0)
          throw new CommandExecutionError(`HTTP ${data.error}: Tweet not found or queryId expired`);
        break;
      }
      const { tweets, nextCursor } = parseTweetDetail(data, seen);
      allTweets.push(...tweets);
      if (!nextCursor || nextCursor === cursor)
        break;
      cursor = nextCursor;
    }
    const trimmed = allTweets.slice(0, kwargs.limit);
    return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
  }
});
export {
  __test__
};
