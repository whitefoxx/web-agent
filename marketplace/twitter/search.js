// ../browser-agent/opencli/clis/twitter/search.js
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/twitter/shared.js

var QUERY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
var SCREEN_NAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
function sanitizeQueryId(resolved, fallbackId) {
  return typeof resolved === "string" && QUERY_ID_PATTERN.test(resolved) ? resolved : fallbackId;
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

// ../browser-agent/opencli/clis/twitter/search.js
var HAS_CHOICES = Object.freeze(["media", "images", "videos", "links", "replies"]);
var EXCLUDE_CHOICES = Object.freeze(["replies", "retweets", "media", "links"]);
var PRODUCT_CHOICES = Object.freeze(["top", "live", "photos", "videos"]);
var PRODUCT_TO_F_PARAM = Object.freeze({
  top: "top",
  live: "live",
  photos: "image",
  videos: "video"
});
var PRODUCT_TO_GRAPHQL_PRODUCT = Object.freeze({
  top: "Top",
  live: "Latest",
  photos: "Photos",
  videos: "Videos"
});
var MAX_PAGINATION_PAGES = 100;
var SEARCH_TIMELINE_OPERATION = {
  queryId: "VhUd6vHVmLBcw0uX-6jMLA",
  features: {
    rweb_video_screen_enabled: true,
    rweb_cashtags_enabled: true,
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
  },
  fieldToggles: {
    withPayments: true,
    withAuxiliaryUserLabels: true,
    withArticleRichContentState: true,
    withArticlePlainText: true,
    withArticleSummaryText: true,
    withArticleVoiceOver: true,
    withGrokAnalyze: true,
    withDisallowedReplyControls: true
  }
};
var FROM_USER_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
var EXCLUDE_TO_OPERATOR = Object.freeze({
  replies: "-filter:replies",
  // `retweets` is a CLI-friendly alias for X's actual `-filter:nativeretweets`.
  retweets: "-filter:nativeretweets",
  media: "-filter:media",
  links: "-filter:links"
});
function buildSearchQuery(rawQuery, kwargs) {
  const parts = [String(rawQuery ?? "").trim()];
  if (kwargs.from) {
    const fromUser = String(kwargs.from).trim().replace(/^@+/, "");
    if (fromUser && !FROM_USER_PATTERN.test(fromUser)) {
      throw new ArgumentError(
        `Invalid --from username: ${JSON.stringify(kwargs.from)}`,
        "Use a Twitter/X handle with 1-15 letters, numbers, or underscores; omit @ or pass @handle."
      );
    }
    if (fromUser) parts.push(`from:${fromUser}`);
  }
  if (kwargs.has) {
    parts.push(`filter:${kwargs.has}`);
  }
  if (kwargs.exclude) {
    const op = EXCLUDE_TO_OPERATOR[kwargs.exclude];
    if (op) parts.push(op);
  }
  return parts.filter(Boolean).join(" ");
}
function resolveSearchFParam(kwargs) {
  if (kwargs.product) {
    const mapped = PRODUCT_TO_F_PARAM[kwargs.product];
    if (mapped) return mapped;
  }
  return kwargs.filter === "live" ? "live" : "top";
}
function resolveSearchProduct(kwargs) {
  const product = kwargs.product || (kwargs.filter === "live" ? "live" : "top");
  return PRODUCT_TO_GRAPHQL_PRODUCT[product] || "Top";
}
function normalizeOperation(operation) {
  if (typeof operation === "string") {
    return {
      queryId: operation,
      features: SEARCH_TIMELINE_OPERATION.features,
      fieldToggles: SEARCH_TIMELINE_OPERATION.fieldToggles
    };
  }
  return {
    queryId: operation?.queryId || SEARCH_TIMELINE_OPERATION.queryId,
    features: operation?.features || SEARCH_TIMELINE_OPERATION.features,
    fieldToggles: operation?.fieldToggles || SEARCH_TIMELINE_OPERATION.fieldToggles
  };
}
function buildSearchTimelineRequest(operation, rawQuery, product, count, cursor) {
  const normalized = normalizeOperation(operation);
  const vars = {
    rawQuery,
    count,
    querySource: "typed_query",
    product
  };
  if (cursor) vars.cursor = cursor;
  return [
    `/i/api/graphql/${normalized.queryId}/SearchTimeline`,
    {
      variables: vars,
      features: normalized.features,
      fieldToggles: normalized.fieldToggles
    }
  ];
}
function unwrapTweetResult(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults" && result.tweet) return result.tweet;
  if (result.tweet) return result.tweet;
  return result;
}
function tweetToRow(result, seen) {
  const tweet = unwrapTweetResult(result);
  if (!tweet?.rest_id || seen.has(tweet.rest_id)) return null;
  seen.add(tweet.rest_id);
  const tweetUser = tweet.core?.user_results?.result;
  const bio = tweetUser?.legacy?.description || "";
  return {
    id: tweet.rest_id,
    author: tweetUser?.core?.screen_name || tweetUser?.legacy?.screen_name || "unknown",
    bio,
    text: tweet.note_tweet?.note_tweet_results?.result?.text || tweet.legacy?.full_text || "",
    created_at: tweet.legacy?.created_at || "",
    likes: tweet.legacy?.favorite_count || 0,
    views: tweet.views?.count || "0",
    url: `https://x.com/i/status/${tweet.rest_id}`,
    ...extractMedia(tweet.legacy),
    card: extractCard(tweet),
    quoted_tweet: extractQuotedTweet(tweet)
  };
}
function parseSearchTimeline(data, seen) {
  const rows = [];
  let nextCursor = null;
  const instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.tweet_results?.result) {
      const row = tweetToRow(value.tweet_results.result, seen);
      if (row) rows.push(row);
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
  return { rows, nextCursor };
}
cli({
  site: "twitter",
  name: "search",
  access: "read",
  description: "Search Twitter/X for tweets, with optional --from / --has / --exclude / --product filters mapped to X's search operators",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "query", type: "string", required: true, positional: true, help: 'Search query. Raw X operators (e.g. "exact phrase", #tag, OR, lang:en, since:YYYY-MM-DD, from:, since:) are passed through unchanged.' },
    { name: "filter", type: "string", default: "top", choices: ["top", "live"], help: "Legacy alias for --product. Kept for backwards compatibility; if --product is set it wins." },
    { name: "product", type: "string", choices: PRODUCT_CHOICES, help: "Which X search tab to read: top (default), live (Latest), photos, videos. Maps to the f= URL param." },
    { name: "from", type: "string", help: "Restrict to tweets authored by <user>. Leading @ is stripped. Equivalent to appending `from:<user>` to the query." },
    { name: "has", type: "string", choices: HAS_CHOICES, help: "Restrict to tweets that have media|images|videos|links|replies. Maps to X's `filter:<has>` operator." },
    { name: "exclude", type: "string", choices: EXCLUDE_CHOICES, help: "Exclude tweets matching <type>: replies|retweets|media|links. Maps to X's `-filter:<x>` operator (retweets → -filter:nativeretweets)." },
    { name: "limit", type: "int", default: 15, help: "Maximum number of tweets to return (default 15). Result count after server-side filtering." },
    { name: "top-by-engagement", type: "int", default: 0, help: "When set to N>0, re-rank the results by weighted engagement (likes×1 + retweets×3 + replies×2 + bookmarks×5 + log10(views+1)×0.5) and return the top N. Default 0 keeps X's native ordering." }
  ],
  columns: ["id", "author", "bio", "text", "created_at", "likes", "views", "url", "has_media", "media_urls", "card", "quoted_tweet"],
  func: async (page, kwargs) => {
    const finalQuery = buildSearchQuery(kwargs.query, kwargs);
    if (!finalQuery) {
      throw new ArgumentError("twitter search query is empty", "Provide a non-empty <query>, or use at least one of --from / --has / --exclude.");
    }
    if (!Number.isInteger(Number(kwargs.limit)) || Number(kwargs.limit) <= 0) {
      throw new ArgumentError("twitter search --limit must be a positive integer", "Example: opencli twitter search opencli --limit 15");
    }
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    await page.goto("https://x.com/home", { waitUntil: "load", settleMs: 1e3 });
    const operation = await resolveTwitterOperationMetadata(page, "SearchTimeline", SEARCH_TIMELINE_OPERATION);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      "Content-Type": "application/json"
    });
    const product = resolveSearchProduct(kwargs);
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    let cursor = null;
    for (let i = 0; i < MAX_PAGINATION_PAGES && results.length < kwargs.limit; i++) {
      const fetchCount = Number(kwargs.limit) - results.length + 10;
      const [requestUrl, requestPayload] = buildSearchTimelineRequest(operation, finalQuery, product, fetchCount, cursor);
      const requestBody = JSON.stringify(requestPayload);
      const data = normalizeTwitterGraphqlPayload(await page.evaluate(`async () => {
        const options = {
          method: 'POST',
          headers: ${headers},
          credentials: 'include',
        };
        options['body'] = ${JSON.stringify(requestBody)};
        const r = await fetch(${JSON.stringify(requestUrl)}, {
          ...options,
        });
        return r.ok ? await r.json() : { error: r.status };
      }`));
      if (data?.error) {
        if (results.length === 0) throw new CommandExecutionError(`HTTP ${data.error}: SearchTimeline fetch failed — queryId may have expired`);
        break;
      }
      const { rows, nextCursor } = parseSearchTimeline(data, seen);
      results.push(...rows);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    const trimmed = results.slice(0, kwargs.limit);
    return applyTopByEngagement(trimmed, kwargs["top-by-engagement"]);
  }
});
var __test__ = {
  buildSearchQuery,
  resolveSearchFParam,
  resolveSearchProduct,
  buildSearchTimelineRequest,
  parseSearchTimeline,
  HAS_CHOICES,
  EXCLUDE_CHOICES,
  PRODUCT_CHOICES,
  EXCLUDE_TO_OPERATOR,
  PRODUCT_TO_F_PARAM,
  FROM_USER_PATTERN
};
export {
  __test__
};
