// ../browser-agent/opencli/clis/twitter/bookmark-folders.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
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

// ../browser-agent/opencli/clis/twitter/bookmark-folders.js
var OPERATION_NAME = "bookmarkFoldersSlice";
var FALLBACK_QUERY_ID = "i78YDd0Tza-dWKw5H2Y7WA";
var FEATURES = {
  rweb_tipjar_consumption_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false
};
function buildUrl(queryId) {
  const variables = JSON.stringify({});
  return `/i/api/graphql/${queryId}/${OPERATION_NAME}?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
}
function parseBookmarkFolders(data, seen) {
  const folders = [];
  const slice = data?.data?.viewer?.bookmark_collections_slice || data?.data?.viewer_v2?.user_results?.result?.bookmark_collections_slice || data?.data?.bookmark_collections_slice || null;
  const items = slice?.items || slice?.timeline?.timeline?.instructions?.flatMap?.((i) => i.entries || []) || [];
  for (const item of items) {
    const folder = item?.bookmarkCollection || item?.content?.bookmarkCollection || item?.content?.itemContent?.bookmark_collection || item;
    const id = folder?.id_str || folder?.id || folder?.rest_id || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = folder?.name || folder?.collection_name || "";
    const itemsCount = Number(folder?.bookmarks_count ?? folder?.items_count ?? folder?.count ?? 0) || 0;
    const createdAt = folder?.created_at || folder?.timestamp_ms || "";
    folders.push({
      id: String(id),
      name: String(name),
      items: itemsCount,
      created_at: String(createdAt)
    });
  }
  return folders;
}
cli({
  site: "twitter",
  name: "bookmark-folders",
  access: "read",
  description: "List your Twitter/X bookmark folders (the user-created collections under Bookmarks). Returns folder id, name, item count, and created_at.",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ["id", "name", "items", "created_at"],
  func: async (page) => {
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const queryId = await resolveTwitterQueryId(page, OPERATION_NAME, FALLBACK_QUERY_ID);
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
      throw new CommandExecutionError(`HTTP ${data.error}: Failed to fetch bookmark folders. queryId may have expired, or your account may not have folder access.`);
    }
    const seen = /* @__PURE__ */ new Set();
    return parseBookmarkFolders(data, seen);
  }
});
var __test__ = {
  parseBookmarkFolders,
  buildUrl
};
export {
  __test__,
  parseBookmarkFolders
};
