// ../browser-agent/opencli/clis/twitter/list-add.js
import { Strategy, cli } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/twitter/shared.js

var QUERY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
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

// ../browser-agent/opencli/clis/twitter/lists.js

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

// ../browser-agent/opencli/clis/twitter/lists.js
var LISTS_QUERY_ID = "78UbkyXwXBD98IgUWXOy9g";
var OPERATION_NAME = "ListsManagementPageTimeline";
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
function buildUrl(queryId) {
  return `/i/api/graphql/${queryId}/${OPERATION_NAME}?features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}
function extractListEntry(entry, seen) {
  const list = entry?.content?.itemContent?.list || entry?.content?.list || entry?.item?.itemContent?.list;
  if (!list) return null;
  const id = list.id_str || list.id || "";
  if (!id || seen.has(id)) return null;
  seen.add(id);
  const mode = typeof list.mode === "string" && /private/i.test(list.mode) ? "private" : "public";
  return {
    id: String(id),
    name: list.name || "",
    members: String(list.member_count ?? 0),
    followers: String(list.subscriber_count ?? 0),
    mode
  };
}
var OWNED_SUBSCRIBED_ENTRY_PREFIX = "owned-subscribed-list-module-";
function isOwnedSubscribedEntry(entry) {
  return typeof entry?.entryId === "string" && entry.entryId.startsWith(OWNED_SUBSCRIBED_ENTRY_PREFIX);
}
function getListsManagementInstructions(data) {
  const instructions = data?.data?.viewer?.list_management_timeline?.timeline?.instructions || data?.data?.viewer_v2?.user_results?.result?.list_management_timeline?.timeline?.instructions || data?.data?.list_management_timeline?.timeline?.instructions || data?.data?.data?.viewer?.list_management_timeline?.timeline?.instructions || data?.data?.data?.viewer_v2?.user_results?.result?.list_management_timeline?.timeline?.instructions || data?.data?.data?.list_management_timeline?.timeline?.instructions;
  return Array.isArray(instructions) ? instructions : null;
}
function parseListsManagement(data, seen) {
  const lists = [];
  const instructions = getListsManagementInstructions(data) || [];
  for (const inst of instructions) {
    for (const entry of inst.entries || []) {
      if (!isOwnedSubscribedEntry(entry)) continue;
      const direct = extractListEntry(entry, seen);
      if (direct) {
        lists.push(direct);
        continue;
      }
      for (const item of entry?.content?.items || []) {
        const nested = extractListEntry(item, seen);
        if (nested) lists.push(nested);
      }
    }
  }
  return lists;
}
var command = cli({
  site: "twitter",
  name: "lists",
  access: "read",
  description: "Get Twitter/X lists for the logged-in user (owned + subscribed)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "limit", type: "int", default: 50, help: "Maximum number of lists to return (default 50)." }
  ],
  columns: ["id", "name", "members", "followers", "mode"],
  func: async (page, kwargs) => {
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
    const queryId = unwrap(queryIdRaw) || LISTS_QUERY_ID;
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const apiUrl = buildUrl(queryId);
    const data = await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(apiUrl)}, { headers: ${headers}, credentials: 'include' });
            return r.ok ? await r.json() : { error: r.status };
        }`);
    if (data?.error) {
      throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch lists. queryId may have expired.`);
    }
    const seen = /* @__PURE__ */ new Set();
    if (!getListsManagementInstructions(data)) {
      throw new CommandExecutionError("Twitter lists returned an unexpected payload shape");
    }
    const lists = parseListsManagement(data, seen);
    if (lists.length === 0) {
      throw new EmptyResultError("twitter lists", "No owned or subscribed lists found");
    }
    return lists.slice(0, limit);
  }
});

// ../browser-agent/opencli/clis/twitter/list-add.js
var USER_BY_SCREEN_NAME_QUERY_ID = "IGgvgiOx4QZndDHuD3x9TQ";
var LISTS_MANAGEMENT_QUERY_ID = "78UbkyXwXBD98IgUWXOy9g";
var LIST_ADD_MEMBER_QUERY_ID = "vWPi0CTMoPFsjsL6W4IynQ";
var LISTS_MANAGEMENT_FEATURES = {
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
function fatalGraphqlErrors(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list.filter(
    (e) => !(e?.path || []).join(".").includes("default_banner_media_results") && !/decode/i.test(e?.message || "")
  );
}
function buildListAddMemberRow({ addResult, memberCountBefore, listId, username, userId }) {
  if (!addResult?.httpOk) {
    throw new CommandExecutionError(
      `Failed to add @${username} to list ${listId}: HTTP ${addResult?.status ?? 0}${addResult?.fetchError ? " (" + addResult.fetchError + ")" : ""}${addResult?.raw ? " — " + addResult.raw : ""}`
    );
  }
  const hasMemberCount = addResult.mc !== null && addResult.mc !== void 0;
  const fatalErrors = fatalGraphqlErrors(addResult.errors);
  if (!hasMemberCount && fatalErrors.length) {
    const msg = fatalErrors.map((e) => e.message || JSON.stringify(e)).join("; ");
    throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: ${msg.slice(0, 300)}`);
  }
  if (!hasMemberCount) {
    throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: no member_count in response`);
  }
  const memberCountAfter = Number(addResult.mc);
  if (!Number.isFinite(memberCountAfter)) {
    throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: invalid member_count in response`);
  }
  if (memberCountAfter < memberCountBefore) {
    throw new CommandExecutionError(
      `Failed to add @${username} to list ${listId}: member_count decreased unexpectedly (${memberCountBefore} → ${memberCountAfter})`
    );
  }
  const countIncreased = memberCountAfter > memberCountBefore;
  if (!countIncreased && addResult.isMember !== true) {
    throw new CommandExecutionError(
      `Failed to add @${username} to list ${listId}: member_count unchanged (${memberCountBefore} → ${memberCountAfter}) and response did not confirm membership`
    );
  }
  const noop = !countIncreased;
  const verifiedBy = `member_count ${memberCountBefore} → ${memberCountAfter}`;
  return {
    listId,
    username,
    userId: String(userId),
    status: noop ? "noop" : "success",
    message: noop ? `@${username} is already a member of list ${listId}` : `Added @${username} to list ${listId} (verified via ${verifiedBy})`
  };
}
cli({
  site: "twitter",
  name: "list-add",
  access: "write",
  description: "Add a user to a Twitter/X list you own (no-op if already a member)",
  domain: "x.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "listId", positional: true, type: "string", required: true, help: "Numeric ID of the list you own (e.g. from `opencli twitter lists`)" },
    { name: "username", positional: true, type: "string", required: true, help: "Twitter/X handle to add (with or without @)" }
  ],
  columns: ["listId", "username", "userId", "status", "message"],
  func: async (page, kwargs) => {
    const listId = String(kwargs.listId || "").trim();
    const username = String(kwargs.username || "").replace(/^@/, "").trim();
    if (!listId || !/^\d+$/.test(listId)) {
      throw new ArgumentError(`Invalid listId: ${JSON.stringify(kwargs.listId)}. Expected numeric ID.`, "Example: opencli twitter list-add 123456789 alice");
    }
    if (!username) {
      throw new ArgumentError("twitter list-add username is required", "Example: opencli twitter list-add 123456789 alice");
    }
    await page.goto("https://x.com");
    await page.wait(3);
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0) throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const userByScreenNameQueryId = await resolveTwitterQueryId(page, "UserByScreenName", USER_BY_SCREEN_NAME_QUERY_ID);
    const headers = JSON.stringify({
      "Authorization": `Bearer ${decodeURIComponent(TWITTER_BEARER_TOKEN)}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes"
    });
    const unwrap = (v) => v && typeof v === "object" && "session" in v && "data" in v ? v.data : v;
    const userLookupUrl = buildUserByScreenNameUrl(userByScreenNameQueryId, username);
    const userIdRaw = await page.evaluate(`async () => {
            const resp = await fetch(${JSON.stringify(userLookupUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!resp.ok) return null;
            const d = await resp.json();
            return d.data?.user?.result?.rest_id || null;
        }`);
    const userId = unwrap(userIdRaw);
    if (!userId) {
      throw new CommandExecutionError(`Could not resolve user @${username}`);
    }
    const listsQueryId = await resolveTwitterQueryId(page, "ListsManagementPageTimeline", LISTS_MANAGEMENT_QUERY_ID);
    const listsUrl = `/i/api/graphql/${listsQueryId}/ListsManagementPageTimeline?features=${encodeURIComponent(JSON.stringify(LISTS_MANAGEMENT_FEATURES))}`;
    const listsDataRaw = await page.evaluate(`async () => {
            const r = await fetch(${JSON.stringify(listsUrl)}, { headers: ${headers}, credentials: 'include' });
            if (!r.ok) return { __error: 'HTTP ' + r.status };
            return await r.json();
        }`);
    const listsData = listsDataRaw;
    const parsedLists = listsData && !listsData.__error ? parseListsManagement(listsData, /* @__PURE__ */ new Set()) : [];
    if (listsData && listsData.__error) {
      throw new CommandExecutionError(`Could not fetch lists: ${listsData.__error}`);
    }
    const targetList = parsedLists.find((l) => l.id === listId);
    if (!targetList) {
      throw new CommandExecutionError(`List ${listId} not found among your lists (${parsedLists.length} lists fetched).`);
    }
    const memberCountBefore = Number(targetList.members) || 0;
    const listAddMemberQueryId = await resolveTwitterQueryId(page, "ListAddMember", LIST_ADD_MEMBER_QUERY_ID);
    const addUrl = `/i/api/graphql/${listAddMemberQueryId}/ListAddMember`;
    const addBody = JSON.stringify({
      variables: { listId, userId: String(userId) },
      queryId: listAddMemberQueryId
    });
    const addResultJsonRaw = await page.evaluate(`async () => {
            try {
                const r = await fetch(${JSON.stringify(addUrl)}, {
                    method: 'POST',
                    headers: Object.assign({}, ${headers}, { 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: ${JSON.stringify(addBody)},
                });
                const text = await r.text();
                let body;
                let raw = null;
                try { body = JSON.parse(text); } catch { body = null; raw = text.slice(0, 300); }
                const list = body && body.data && body.data.list ? body.data.list : null;
                return JSON.stringify([
                    r.ok,
                    r.status,
                    list ? list.member_count : null,
                    list ? list.is_member : null,
                    body && body.errors ? body.errors : null,
                    raw,
                    null,
                ]);
            } catch (e) {
                return JSON.stringify([false, 0, null, null, null, null, String(e)]);
            }
        }`);
    const addResultJson = unwrap(addResultJsonRaw);
    let addResultTuple;
    try {
      addResultTuple = JSON.parse(addResultJson);
    } catch {
      throw new CommandExecutionError(`Failed to add @${username} to list ${listId}: malformed mutation response envelope`);
    }
    const addResult = /* @__PURE__ */ Object.create(null);
    addResult.httpOk = Boolean(addResultTuple?.[0]);
    addResult.status = Number(addResultTuple?.[1]) || 0;
    addResult.mc = addResultTuple?.[2];
    addResult.isMember = addResultTuple?.[3];
    addResult.errors = addResultTuple?.[4];
    addResult.raw = addResultTuple?.[5];
    addResult.fetchError = addResultTuple?.[6];
    return [buildListAddMemberRow({ addResult, memberCountBefore, listId, username, userId })];
  }
});
export {
  buildListAddMemberRow
};
