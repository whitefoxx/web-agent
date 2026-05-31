// ../browser-agent/opencli/clis/xiaohongshu/note.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CliError, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/xiaohongshu/note-helpers.js
import { ArgumentError } from "@jackwener/opencli/errors";
function parseNoteId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/(?:explore|note|search_result|discovery\/item)\/([a-f0-9]+)|\/user\/profile\/[^/?#]+\/([a-f0-9]+)/i);
  return match ? match[1] || match[2] : trimmed;
}
var XHS_SIGNED_URL_HINT = "Pass a full Xiaohongshu note URL with xsec_token from search results or user/profile context.";
function isShortLink(input) {
  return /^https?:\/\/xhslink\.com\//i.test(input);
}
function isHostMatch(hostname, cookieRoot) {
  const normalized = hostname.toLowerCase();
  return normalized === cookieRoot || normalized.endsWith("." + cookieRoot);
}
function isSupportedNotePath(pathname) {
  return /^\/(?:explore|note|search_result|discovery\/item)\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname) || /^\/user\/profile\/[^/?#]+\/[a-f0-9]+(?:[/?#]|$)/i.test(pathname);
}
function buildNoteUrl(input, options = {}) {
  const {
    allowShortLink = false,
    commandName = "xiaohongshu note",
    cookieRoot = "xiaohongshu.com",
    signedUrlHint = XHS_SIGNED_URL_HINT
  } = options;
  const trimmed = input.trim();
  const message = `${commandName} now requires a full signed URL`;
  const hint = allowShortLink ? `${signedUrlHint} For downloads, xhslink short links are also supported.` : signedUrlHint;
  if (/^https?:\/\//.test(trimmed)) {
    if (isShortLink(trimmed)) {
      if (allowShortLink)
        return trimmed;
      throw new ArgumentError(message, hint);
    }
    try {
      const url = new URL(trimmed);
      const xsecToken = url.searchParams.get("xsec_token")?.trim();
      if (isHostMatch(url.hostname, cookieRoot) && isSupportedNotePath(url.pathname) && xsecToken) {
        return trimmed;
      }
    } catch {
    }
    throw new ArgumentError(message, hint);
  }
  throw new ArgumentError(message, hint);
}

// ../browser-agent/opencli/clis/xiaohongshu/note.js
var NOTE_EXTRACT_JS = `
      (() => {
        const bodyText = document.body?.innerText || ''
        const loginWall = /\u767B\u5F55\u540E\u67E5\u770B|\u8BF7\u767B\u5F55/.test(bodyText)
        const notFound = /\u9875\u9762\u4E0D\u89C1\u4E86|\u7B14\u8BB0\u4E0D\u5B58\u5728|\u65E0\u6CD5\u6D4F\u89C8/.test(bodyText)
        const securityBlock = /\u5B89\u5168\u9650\u5236|\u8BBF\u95EE\u94FE\u63A5\u5F02\u5E38/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)

        const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()

        const title = clean(document.querySelector('#detail-title, .title'))
        const desc = clean(document.querySelector('#detail-desc, .desc, .note-text'))
        const author = clean(document.querySelector('.username, .author-wrapper .name'))
        // Scope to .interact-container \u2014 the post's main interaction bar.
        // Without scoping, .like-wrapper / .chat-wrapper also match each
        // comment's like/reply buttons in the comment section, and
        // querySelector returns the FIRST match (a comment's count, not the
        // post's). The post's true counts live inside .interact-container.
        const likes = clean(document.querySelector('.interact-container .like-wrapper .count'))
        const collects = clean(document.querySelector('.interact-container .collect-wrapper .count'))
        const comments = clean(document.querySelector('.interact-container .chat-wrapper .count'))

        // Try to extract tags/topics
        const tags = []
        document.querySelectorAll('#detail-desc a.tag, #detail-desc a[href*="search_result"]').forEach(el => {
          const t = (el.textContent || '').trim()
          if (t) tags.push(t)
        })

        return { pageUrl: location.href, securityBlock, loginWall, notFound, title, desc, author, likes, collects, comments, tags }
      })()
    `;
var command = cli({
  site: "xiaohongshu",
  name: "note",
  access: "read",
  description: "\u83B7\u53D6\u5C0F\u7EA2\u4E66\u7B14\u8BB0\u6B63\u6587\u548C\u4E92\u52A8\u6570\u636E",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  navigateBefore: false,
  args: [
    { name: "note-id", required: true, positional: true, help: "Full Xiaohongshu note URL with xsec_token" }
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const raw = String(kwargs["note-id"]);
    const noteId = parseNoteId(raw);
    const url = buildNoteUrl(raw, { commandName: "xiaohongshu note" });
    await page.goto(url);
    await page.wait({ time: 2 + Math.random() * 3 });
    const data = await page.evaluate(NOTE_EXTRACT_JS);
    if (!data || typeof data !== "object") {
      throw new EmptyResultError("xiaohongshu/note", "Unexpected evaluate response");
    }
    if (data.securityBlock) {
      throw new CliError("SECURITY_BLOCK", "Xiaohongshu security block: the note detail page was blocked by risk control.", /^https?:\/\//.test(raw) ? "The page may be temporarily restricted. Try again later or from a different session." : "Try using a full URL from search results (with xsec_token) instead of a bare note ID.");
    }
    if (data.loginWall) {
      throw new AuthRequiredError("www.xiaohongshu.com", "Note content requires login");
    }
    if (data.notFound) {
      throw new EmptyResultError("xiaohongshu/note", `Note ${noteId} not found or unavailable \u2014 it may have been deleted or restricted`);
    }
    const d = data;
    const numOrZero = (v) => /^\d+/.test(v) ? v : "0";
    if (!d.title && !d.author) {
      throw new EmptyResultError("xiaohongshu/note", "The note page loaded without visible content. The note may be deleted or restricted.");
    }
    const rows = [
      { field: "title", value: d.title || "" },
      { field: "author", value: d.author || "" },
      { field: "content", value: d.desc || "" },
      { field: "likes", value: numOrZero(d.likes || "") },
      { field: "collects", value: numOrZero(d.collects || "") },
      { field: "comments", value: numOrZero(d.comments || "") }
    ];
    if (d.tags?.length) {
      rows.push({ field: "tags", value: d.tags.join(", ") });
    }
    return rows;
  }
});
export {
  NOTE_EXTRACT_JS,
  command
};
