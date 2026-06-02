// ../browser-agent/opencli/clis/twitter/article.js
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

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

// ../browser-agent/opencli/clis/twitter/article.js
var TWEET_RESULT_BY_REST_ID_QUERY_ID = "7xflPyRiUxGVbJd4uWmbfg";
cli({
  site: "twitter",
  name: "article",
  access: "read",
  description: "Fetch a Twitter Article (long-form content) and export as Markdown",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "tweet-id", type: "string", positional: true, required: true, help: "Tweet ID or URL containing the article" }
  ],
  columns: ["title", "author", "content", "url"],
  func: async (page, kwargs) => {
    let tweetId = kwargs["tweet-id"];
    const isArticleUrl = /\/article\/\d+/.test(tweetId);
    const urlMatch = tweetId.match(/\/(?:status|article)\/(\d+)/);
    if (urlMatch)
      tweetId = urlMatch[1];
    // Trampoline idempotency: page.goto re-executes this func from the top after
    // reinjection, so the leading article->status navigation would ping-pong. If a
    // replay already landed on the final /i/status/<id> scrape page, skip the leading
    // gotos and re-derive tweetId from the current URL (the canonical id lives there).
    // See adapter-hot-plug.md §10.21.
    const currentUrl = await page.getCurrentUrl().catch(() => "");
    const onStatusPage = currentUrl.match(/\/i\/status\/(\d+)/);
    if (onStatusPage) {
      tweetId = onStatusPage[1];
    } else {
      if (isArticleUrl) {
        await page.goto(`https://x.com/i/article/${tweetId}`);
        await page.wait(3);
        const resolvedId = await page.evaluate(`
          (function() {
            var links = document.querySelectorAll('a[href*="/status/"]');
            for (var i = 0; i < links.length; i++) {
              var m = links[i].href.match(/\\/status\\/(\\d+)/);
              if (m) return m[1];
            }
            var og = document.querySelector('meta[property="og:url"]');
            if (og && og.content) {
              var m2 = og.content.match(/\\/status\\/(\\d+)/);
              if (m2) return m2[1];
            }
            return null;
          })()
        `);
        if (!resolvedId || typeof resolvedId !== "string") {
          throw new CommandExecutionError(`Could not resolve article ${tweetId} to a tweet ID. The article page may not contain a linked tweet.`);
        }
        tweetId = resolvedId;
      }
      await page.goto(`https://x.com/i/status/${tweetId}`);
      await page.wait(3);
    }
    const cookies = await page.getCookies({ url: "https://x.com" });
    const ct0 = cookies.find((c) => c.name === "ct0")?.value || null;
    if (!ct0)
      throw new AuthRequiredError("x.com", "Not logged into x.com (no ct0 cookie)");
    const queryId = await resolveTwitterQueryId(page, "TweetResultByRestId", TWEET_RESULT_BY_REST_ID_QUERY_ID);
    const result = await page.evaluate(`
      async () => {
        const tweetId = "${tweetId}";
        const ct0 = ${JSON.stringify(ct0)};

        const bearer = ${JSON.stringify(TWITTER_BEARER_TOKEN)};
        const headers = {
          'Authorization': 'Bearer ' + decodeURIComponent(bearer),
          'X-Csrf-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes'
        };

        const variables = JSON.stringify({
          tweetId: tweetId,
          withCommunity: false,
          includePromotedContent: false,
          withVoice: false,
        });
        const features = JSON.stringify({
          longform_notetweets_consumption_enabled: true,
          responsive_web_twitter_article_tweet_consumption_enabled: true,
          longform_notetweets_rich_text_read_enabled: true,
          longform_notetweets_inline_media_enabled: true,
          articles_preview_enabled: true,
          responsive_web_graphql_exclude_directive_enabled: true,
          verified_phone_label_enabled: false,
        });
        const fieldToggles = JSON.stringify({
          withArticleRichContentState: true,
          withArticlePlainText: true,
        });

        const url = '/i/api/graphql/' + ${JSON.stringify(queryId)} + '/TweetResultByRestId?variables='
          + encodeURIComponent(variables)
          + '&features=' + encodeURIComponent(features)
          + '&fieldToggles=' + encodeURIComponent(fieldToggles);

        const resp = await fetch(url, {headers, credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status, hint: 'Tweet may not exist or queryId expired'};
        const d = await resp.json();

        const result = d.data?.tweetResult?.result;
        if (!result) return {error: 'Article not found'};

        // Unwrap TweetWithVisibilityResults
        const tw = result.tweet || result;
        const legacy = tw.legacy || {};
        const user = tw.core?.user_results?.result;
        const screenName = user?.legacy?.screen_name || user?.core?.screen_name || 'unknown';

        // Extract article content
        const articleResults = tw.article?.article_results?.result;
        if (!articleResults) {
          // Fallback: return note_tweet text if present
          const noteText = tw.note_tweet?.note_tweet_results?.result?.text;
          if (noteText) {
            return [{
              title: '(Note Tweet)',
              author: screenName,
              content: noteText,
              url: 'https://x.com/' + screenName + '/status/' + tweetId,
            }];
          }
          return {error: 'Tweet ' + tweetId + ' has no article content'};
        }

        const title = articleResults.title || '(Untitled)';
        const contentState = articleResults.content_state || {};
        const blocks = contentState.blocks || [];

        // Convert draft.js blocks to Markdown
        const parts = [];
        let orderedCounter = 0;
        for (const block of blocks) {
          const blockType = block.type || 'unstyled';
          if (blockType === 'atomic') continue;
          const text = block.text || '';
          if (!text) continue;
          if (blockType !== 'ordered-list-item') orderedCounter = 0;

          if (blockType === 'header-one')           parts.push('# ' + text);
          else if (blockType === 'header-two')      parts.push('## ' + text);
          else if (blockType === 'header-three')    parts.push('### ' + text);
          else if (blockType === 'blockquote')       parts.push('> ' + text);
          else if (blockType === 'unordered-list-item') parts.push('- ' + text);
          else if (blockType === 'ordered-list-item') {
            orderedCounter++;
            parts.push(orderedCounter + '. ' + text);
          }
          else if (blockType === 'code-block')       parts.push('\`\`\`\\n' + text + '\\n\`\`\`');
          else                                       parts.push(text);
        }

        return [{
          title,
          author: screenName,
          content: parts.join('\\n\\n') || legacy.full_text || '',
          url: 'https://x.com/' + screenName + '/status/' + tweetId,
        }];
      }
    `);
    if (result?.error) {
      throw new CommandExecutionError(result.error + (result.hint ? ` (${result.hint})` : ""));
    }
    return result || [];
  }
});
