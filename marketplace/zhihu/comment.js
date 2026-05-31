// ../browser-agent/opencli/clis/zhihu/comment.js
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
var NAV_SCOPE_SELECTOR = 'header, nav, [role="banner"], [role="navigation"]';
var PROFILE_LINK_SELECTOR = 'a[href^="/people/"]';
var AVATAR_SELECTOR = 'img, [class*="Avatar"], [data-testid*="avatar" i], [aria-label*="头像"]';
var SELF_LABEL_TOKENS = ["我", "我的", "个人主页"];
var EXPLICIT_IDENTITY_META_TOKEN_GROUPS = [
  ["self"],
  ["current", "user"],
  ["account", "profile"],
  ["my", "profile"],
  ["my", "account"]
];
var IN_PAGE_EXPLICIT_IDENTITY_META_TOKEN_GROUPS = JSON.stringify(EXPLICIT_IDENTITY_META_TOKEN_GROUPS);
function defaultFileReaderDeps() {
  return {
    readFile,
    stat: (path) => stat(path),
    decodeUtf8: (raw) => new TextDecoder("utf-8", { fatal: true }).decode(raw)
  };
}
function requireExecute(kwargs) {
  if (!kwargs.execute) {
    throw new CliError("INVALID_INPUT", "This Zhihu write command requires --execute");
  }
}
async function resolvePayload(kwargs, deps = defaultFileReaderDeps()) {
  const text = typeof kwargs.text === "string" ? kwargs.text : void 0;
  const file = typeof kwargs.file === "string" ? kwargs.file : void 0;
  if (text && file) {
    throw new CliError("INVALID_INPUT", "Use either <text> or --file, not both");
  }
  let resolved = text ?? "";
  if (file) {
    let fileStat;
    try {
      fileStat = await deps.stat(file);
    } catch {
      throw new CliError("INVALID_INPUT", `File not found: ${file}`);
    }
    if (!fileStat.isFile()) {
      throw new CliError("INVALID_INPUT", `File must be a readable text file: ${file}`);
    }
    let raw;
    try {
      raw = await deps.readFile(file);
    } catch {
      throw new CliError("INVALID_INPUT", `File could not be read: ${file}`);
    }
    try {
      resolved = deps.decodeUtf8(raw);
    } catch {
      throw new CliError("INVALID_INPUT", `File could not be decoded as UTF-8 text: ${file}`);
    }
  }
  if (!resolved.trim()) {
    throw new CliError("INVALID_INPUT", "Payload cannot be empty or whitespace only");
  }
  return resolved;
}
function buildResolveCurrentUserIdentityJs() {
  return `(() => {
    const selfLabelTokens = ${JSON.stringify(SELF_LABEL_TOKENS)};
    const explicitIdentityMetaTokenGroups = ${IN_PAGE_EXPLICIT_IDENTITY_META_TOKEN_GROUPS};
    const navScopeSelector = ${JSON.stringify(NAV_SCOPE_SELECTOR)};
    const profileLinkSelector = ${JSON.stringify(PROFILE_LINK_SELECTOR)};
    const avatarSelector = ${JSON.stringify(AVATAR_SELECTOR)};

    const hasExplicitIdentityLabel = (text) => {
      const normalized = String(text || '').toLowerCase();
      return selfLabelTokens.some((token) => String(text || '').includes(token))
        || normalized.includes('my profile')
        || normalized.includes('my account');
    };

    const tokenizeIdentityMeta = (text) => String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);

    const hasExplicitIdentityMeta = (text) => {
      const tokens = new Set(tokenizeIdentityMeta(text));
      return explicitIdentityMetaTokenGroups.some((group) => group.every((token) => tokens.has(token)));
    };

    const getSlugFromIdentityLink = (node, allowAvatarOnly) => {
      const href = node.getAttribute('href') || '';
      const match = href.match(/^\\/people\\/([A-Za-z0-9_-]+)/);
      if (!match) return null;

      const aria = node.getAttribute('aria-label') || '';
      const title = node.getAttribute('title') || '';
      const testid = node.getAttribute('data-testid') || '';
      const className = node.getAttribute('class') || '';
      const rel = node.getAttribute('rel') || '';
      const identityLabel = \`\${aria} \${title} \${node.textContent || ''}\`;
      const identityMeta = \`\${testid} \${className} \${rel}\`;
      const hasAvatar = Boolean(node.querySelector(avatarSelector));

      if (hasExplicitIdentityLabel(identityLabel) || hasExplicitIdentityMeta(identityMeta)) return match[1];
      if (allowAvatarOnly && hasAvatar) return match[1];
      return null;
    };

    const findCurrentUserSlugFromRoots = (roots, allowAvatarOnly) => {
      for (const root of roots) {
        for (const node of Array.from(root.querySelectorAll(profileLinkSelector))) {
          const slug = getSlugFromIdentityLink(node, allowAvatarOnly);
          if (slug) return slug;
        }
      }
      return null;
    };

    const scopedGlobal = globalThis;
    const state = scopedGlobal.__INITIAL_STATE__ || (scopedGlobal.window && scopedGlobal.window.__INITIAL_STATE__) || null;
    const slugFromState = state && (state.topstory && state.topstory.me && state.topstory.me.slug)
      || (state && state.me && state.me.slug)
      || (state && state.initialState && state.initialState.me && state.initialState.me.slug);
    if (typeof slugFromState === 'string' && slugFromState) return { slug: slugFromState };

    const navScopes = Array.from(document.querySelectorAll(navScopeSelector));
    const slug = findCurrentUserSlugFromRoots(navScopes, true) || findCurrentUserSlugFromRoots([document], false);
    if (slug) return { slug };

    var avatarImgs = document.querySelectorAll('header img[alt*="\\u4e3b\\u9875"]');
    for (var ai = 0; ai < avatarImgs.length; ai++) {
      var altMatch = (avatarImgs[ai].alt || '').match(/\\u70b9\\u51fb\\u6253\\u5f00(.+?)\\u7684\\u4e3b\\u9875/);
      if (altMatch) return { slug: altMatch[1] };
    }
    return null;
  })()`;
}
async function resolveCurrentUserIdentity(page) {
  const identity = await page.evaluate(buildResolveCurrentUserIdentityJs());
  if (!identity?.slug) {
    throw new CliError("ACTION_NOT_AVAILABLE", "Could not resolve the logged-in Zhihu user identity before write");
  }
  return identity.slug;
}
function buildResultRow(message, targetType, target, outcome, extra = {}) {
  for (const key of Object.keys(extra)) {
    if (RESULT_ROW_RESERVED_KEYS.has(key)) {
      throw new CliError("INVALID_INPUT", `Result extra field cannot overwrite reserved key: ${key}`);
    }
  }
  return [{ status: "success", outcome, message, target_type: targetType, target, ...extra }];
}

// ../browser-agent/opencli/clis/zhihu/comment.js
cli({
  site: "zhihu",
  name: "comment",
  access: "write",
  description: "Create a top-level comment on a Zhihu answer or article",
  domain: "zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "target", positional: true, required: true, help: "Zhihu target URL or typed target" },
    { name: "text", positional: true, help: "Comment text" },
    { name: "file", help: "Comment text file path" },
    { name: "execute", type: "boolean", help: "Actually perform the write action" }
  ],
  columns: ["status", "outcome", "message", "target_type", "target", "author_identity", "created_url"],
  func: async (page, kwargs) => {
    if (!page)
      throw new CommandExecutionError("Browser session required for zhihu comment");
    requireExecute(kwargs);
    const rawTarget = String(kwargs.target);
    const target = assertAllowedKinds("comment", parseTarget(rawTarget));
    const payload = await resolvePayload(kwargs);
    await page.goto(target.url);
    await page.wait(3);
    const authorIdentity = await resolveCurrentUserIdentity(page);
    const apiResult = await page.evaluate(`(async () => {
            var targetKind = ${JSON.stringify(target.kind)};
            var targetId = ${JSON.stringify(target.id)};
            var content = ${JSON.stringify(payload)};
            var resourceType = targetKind === 'answer' ? 'answers' : 'articles';
            var url = 'https://www.zhihu.com/api/v4/' + resourceType + '/' + targetId + '/comments';
            var resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content }),
            });
            var data = await resp.json();
            if (!resp.ok) return { ok: false, status: resp.status, message: data.error ? data.error.message : 'unknown error' };
            if (!data || !data.id) return { ok: false, status: resp.status, message: 'Comment API response did not include a created comment id' };
            return { ok: true, id: data.id, url: data.url };
        })()`);
    if (!apiResult?.ok) {
      throw new CliError("COMMAND_EXEC", apiResult?.message || "Failed to create comment");
    }
    return buildResultRow(`Commented on ${target.kind} ${target.id}`, target.kind, rawTarget, "created", {
      author_identity: authorIdentity,
      created_url: apiResult.url || ""
    });
  }
});
