// ../browser-agent/opencli/clis/zhihu/favorite.js
import { CliError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/zhihu/target.js

var USER_RE = /^user:([A-Za-z0-9_-]+)$/;
var QUESTION_RE = /^question:(\d+)$/;
var ANSWER_RE = /^answer:(\d+):(\d+)$/;
var ARTICLE_RE = /^article:(\d+)$/;
var USER_PATH_RE = /^\/people\/([A-Za-z0-9_-]+)\/?$/;
var QUESTION_PATH_RE = /^\/question\/(\d+)\/?$/;
var ANSWER_PATH_RE = /^\/question\/(\d+)\/answer\/(\d+)\/?$/;
var ARTICLE_PATH_RE = /^\/p\/(\d+)\/?$/;
var EMPTY_AUTHORITY_RE = /^https:\/\/(?::)?@/i;
function isAllowedZhihuUrl(url) {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "";
}
function parseTarget(input) {
  const value = String(input).trim();
  if (EMPTY_AUTHORITY_RE.test(value)) {
    throw new CliError("INVALID_INPUT", "Zhihu write commands require a normal HTTPS Zhihu URL without malformed authority", "Example: https://www.zhihu.com/question/123456");
  }
  if (value.startsWith("answer:") && !ANSWER_RE.test(value)) {
    throw new CliError("INVALID_INPUT", "Invalid answer target, expected answer:<questionId>:<answerId>", "Example: opencli zhihu like answer:123:456 --execute");
  }
  let match = value.match(USER_RE);
  if (match) {
    return { kind: "user", slug: match[1], url: `https://www.zhihu.com/people/${match[1]}` };
  }
  match = value.match(QUESTION_RE);
  if (match) {
    return { kind: "question", id: match[1], url: `https://www.zhihu.com/question/${match[1]}` };
  }
  match = value.match(ANSWER_RE);
  if (match) {
    return {
      kind: "answer",
      questionId: match[1],
      id: match[2],
      url: `https://www.zhihu.com/question/${match[1]}/answer/${match[2]}`
    };
  }
  match = value.match(ARTICLE_RE);
  if (match) {
    return { kind: "article", id: match[1], url: `https://zhuanlan.zhihu.com/p/${match[1]}` };
  }
  try {
    const url = new URL(value);
    if (!isAllowedZhihuUrl(url)) {
      throw new Error("unsupported zhihu url variant");
    }
    if (url.hostname === "www.zhihu.com") {
      const userMatch = url.pathname.match(USER_PATH_RE);
      if (userMatch) {
        const slug = userMatch[1];
        return { kind: "user", slug, url: `https://www.zhihu.com/people/${slug}` };
      }
      const questionMatch = url.pathname.match(QUESTION_PATH_RE);
      if (questionMatch) {
        return { kind: "question", id: questionMatch[1], url: `https://www.zhihu.com/question/${questionMatch[1]}` };
      }
      const answerMatch = url.pathname.match(ANSWER_PATH_RE);
      if (answerMatch) {
        return {
          kind: "answer",
          questionId: answerMatch[1],
          id: answerMatch[2],
          url: `https://www.zhihu.com/question/${answerMatch[1]}/answer/${answerMatch[2]}`
        };
      }
    }
    if (url.hostname === "zhuanlan.zhihu.com") {
      const articleMatch = url.pathname.match(ARTICLE_PATH_RE);
      if (articleMatch) {
        return { kind: "article", id: articleMatch[1], url: `https://zhuanlan.zhihu.com/p/${articleMatch[1]}` };
      }
    }
  } catch {
  }
  throw new CliError("INVALID_INPUT", "Zhihu write commands require a Zhihu URL or typed target like question:123 or answer:123:456", "Example: opencli zhihu like answer:123:456 --execute");
}
function assertAllowedKinds(command, target) {
  const allowed = {
    follow: ["user", "question"],
    like: ["answer", "article"],
    favorite: ["answer", "article"],
    comment: ["answer", "article"],
    answer: ["question"]
  };
  if (!allowed[command]?.includes(target.kind)) {
    throw new CliError("UNSUPPORTED_TARGET", `zhihu ${command} does not support ${target.kind} targets`);
  }
  return target;
}

// ../browser-agent/opencli/clis/zhihu/write-shared.js
import { readFile, stat } from "node:fs/promises";

var RESULT_ROW_RESERVED_KEYS = /* @__PURE__ */ new Set(["status", "outcome", "message", "target_type", "target"]);
var EXPLICIT_IDENTITY_META_TOKEN_GROUPS = [
  ["self"],
  ["current", "user"],
  ["account", "profile"],
  ["my", "profile"],
  ["my", "account"]
];
var IN_PAGE_EXPLICIT_IDENTITY_META_TOKEN_GROUPS = JSON.stringify(EXPLICIT_IDENTITY_META_TOKEN_GROUPS);
function requireExecute(kwargs) {
  if (!kwargs.execute) {
    throw new CliError("INVALID_INPUT", "This Zhihu write command requires --execute");
  }
}
function buildResultRow(message, targetType, target, outcome, extra = {}) {
  for (const key of Object.keys(extra)) {
    if (RESULT_ROW_RESERVED_KEYS.has(key)) {
      throw new CliError("INVALID_INPUT", `Result extra field cannot overwrite reserved key: ${key}`);
    }
  }
  return [{ status: "success", outcome, message, target_type: targetType, target, ...extra }];
}

// ../browser-agent/opencli/clis/zhihu/favorite.js
cli({
  site: "zhihu",
  name: "favorite",
  access: "write",
  description: "Favorite a Zhihu answer or article into a specific collection",
  domain: "zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "target", positional: true, required: true, help: "Zhihu target URL or typed target" },
    { name: "collection", help: "Collection name" },
    { name: "collection-id", help: "Stable collection id" },
    { name: "execute", type: "boolean", help: "Actually perform the write action" }
  ],
  columns: ["status", "outcome", "message", "target_type", "target", "collection_name", "collection_id"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for zhihu favorite");
    requireExecute(kwargs);
    const rawTarget = String(kwargs.target);
    const target = assertAllowedKinds("favorite", parseTarget(rawTarget));
    const collectionName = typeof kwargs.collection === "string" ? kwargs.collection : void 0;
    const collectionId = typeof kwargs["collection-id"] === "string" ? kwargs["collection-id"] : void 0;
    if ((collectionName ? 1 : 0) + (collectionId ? 1 : 0) !== 1) {
      throw new CliError("INVALID_INPUT", "Use exactly one of --collection or --collection-id");
    }
    await page.goto("https://www.zhihu.com");
    await page.wait(2);
    const apiResult = await page.evaluate(`(async () => {
            var collectionId = ${JSON.stringify(collectionId || null)};
            var collectionName = ${JSON.stringify(collectionName || null)};
            var targetKind = ${JSON.stringify(target.kind)};
            var targetId = ${JSON.stringify(target.id)};
            var normalizeCollectionName = function(value) {
                return String(value || '')
                    .replace(/\\s+/g, ' ')
                    .replace(/\\s+\\d+\\s*(条内容|个内容|items?)$/i, '')
                    .replace(/\\s+(公开|私密|默认)$/i, '')
                    .trim()
                    .toLowerCase();
            };

            if (!collectionId && collectionName) {
                var listResp = await fetch('https://www.zhihu.com/api/v4/people/self/collections?limit=50', { credentials: 'include' });
                if (!listResp.ok) return { ok: false, message: 'Failed to list collections: HTTP ' + listResp.status };
                var listData = {};
                try { listData = await listResp.json(); } catch(e) {
                    return { ok: false, message: 'Failed to parse collection list' };
                }
                var needle = normalizeCollectionName(collectionName);
                var matches = (listData.data || []).filter(function(c) { return normalizeCollectionName(c.title) === needle; });
                if (matches.length === 0) return { ok: false, message: 'Collection not found: ' + collectionName };
                if (matches.length > 1) return { ok: false, message: 'Collection name is ambiguous: ' + collectionName };
                collectionId = String(matches[0].id);
            }

            var resp = await fetch('https://www.zhihu.com/api/v4/favlists/' + collectionId + '/items', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_id: targetId, item_type: targetKind }),
            });
            if (resp.ok || resp.status === 204) return { ok: true, collectionId: collectionId };
            var data = {};
            try { data = await resp.json(); } catch(e) {}
            return { ok: false, message: data.error ? data.error.message : 'HTTP ' + resp.status };
        })()`);
    if (!apiResult?.ok) {
      throw new CliError("COMMAND_EXEC", apiResult?.message || "Failed to favorite");
    }
    return buildResultRow(`Favorited ${target.kind} ${target.id}`, target.kind, rawTarget, "applied", {
      collection_name: collectionName || "",
      collection_id: apiResult.collectionId || collectionId || ""
    });
  }
});
