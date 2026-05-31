// ../browser-agent/opencli/clis/zhihu/collection.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { log } from "@jackwener/opencli/logger";

// ../browser-agent/opencli/clis/zhihu/text.js
function decodeEntity(codePoint) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1114111 ? String.fromCodePoint(codePoint) : null;
}
function stripHtml(html, { preserveBlocks = false } = {}) {
  if (!html) return "";
  let text = String(html);
  if (preserveBlocks) {
    text = text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n\n");
  }
  return text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (entity, value) => decodeEntity(Number(value)) ?? entity).replace(/&#x([0-9a-f]+);/gi, (entity, value) => decodeEntity(Number.parseInt(value, 16)) ?? entity).replace(/\n{3,}/g, "\n\n").trim();
}

// ../browser-agent/opencli/clis/zhihu/collection.js
function validatePositiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ArgumentError(`zhihu collection --${name} must be a positive integer`, "Example: opencli zhihu collection 83283292 --limit 20");
  }
  return n;
}
function validateNonNegativeInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ArgumentError(`zhihu collection --${name} must be a non-negative integer`, "Example: opencli zhihu collection 83283292 --offset 0");
  }
  return n;
}
async function fetchCollectionPage(page, collectionId, offset, limit) {
  const url = `https://www.zhihu.com/api/v4/collections/${collectionId}/items?offset=${offset}&limit=${limit}`;
  const data = await page.evaluate(`
    (async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!r.ok) return { __httpError: r.status };
      return await r.json();
    })()
  `);
  if (!data || data.__httpError) {
    const status = data?.__httpError;
    if (status === 401 || status === 403) {
      throw new AuthRequiredError("www.zhihu.com", "Failed to fetch collection data from Zhihu. Please ensure you are logged in.");
    }
    throw new CommandExecutionError(
      status ? `Zhihu collection request failed (HTTP ${status})` : "Zhihu collection request failed",
      "Try again later or rerun with -v for more detail"
    );
  }
  return data;
}
function itemKey(item) {
  const content = item?.content || {};
  return `${content.type || ""}:${content.id || content.url || JSON.stringify(content).slice(0, 80)}`;
}
function mapCollectionItem(item, rank) {
  const content = item.content || {};
  const type = content.type || "";
  if (!["answer", "article", "pin"].includes(type)) {
    throw new CommandExecutionError(
      `Zhihu collection returned unsupported content type: ${type || "missing"}`,
      "Collection items require a supported content.type so the row identity, title, and URL are not silently blank."
    );
  }
  let title = "";
  let excerpt = "";
  let url = "";
  let author = "";
  let votes = 0;
  if (type === "answer") {
    const question = content.question || {};
    title = question.title || "";
    excerpt = stripHtml(content.content || "").substring(0, 150);
    url = content.url || `https://www.zhihu.com/question/${question.id}/answer/${content.id}`;
    author = content.author?.name || "\u533F\u540D\u7528\u6237";
    votes = content.voteup_count || 0;
  } else if (type === "article") {
    title = content.title || "";
    excerpt = stripHtml(content.content || "").substring(0, 150);
    url = content.url || `https://zhuanlan.zhihu.com/p/${content.id}`;
    author = content.author?.name || "\u533F\u540D\u7528\u6237";
    votes = content.voteup_count || 0;
  } else if (type === "pin") {
    title = "\u60F3\u6CD5";
    excerpt = stripHtml((content.content || []).map((c) => c.content || "").join(" ")).substring(0, 150);
    url = content.url || `https://www.zhihu.com/pin/${content.id}`;
    author = content.author?.name || "\u533F\u540D\u7528\u6237";
    votes = content.reaction_count || 0;
  }
  if (!String(title || "").trim() || !String(url || "").trim() || url.includes("undefined")) {
    throw new CommandExecutionError(
      "Zhihu collection returned a malformed item without title or URL identity",
      "Collection item rows require type, title, and URL so malformed payloads do not become blank listing rows."
    );
  }
  return {
    rank,
    type,
    title: stripHtml(title).substring(0, 100),
    author,
    votes,
    excerpt,
    url
  };
}
cli({
  site: "zhihu",
  name: "collection",
  access: "read",
  description: "\u77E5\u4E4E\u6536\u85CF\u5939\u5185\u5BB9\u5217\u8868\uFF08\u9700\u8981\u767B\u5F55\uFF09",
  domain: "www.zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", positional: true, required: true, help: "\u6536\u85CF\u5939 ID (\u6570\u5B57\uFF0C\u53EF\u4ECE\u6536\u85CF\u5939 URL \u4E2D\u83B7\u53D6)" },
    { name: "offset", type: "int", default: 0, help: "\u8D77\u59CB\u504F\u79FB\u91CF\uFF08\u7528\u4E8E\u5206\u9875\uFF09" },
    { name: "limit", type: "int", default: 20, help: "\u6BCF\u9875\u6570\u91CF\uFF08\u6700\u5927 20\uFF09" }
  ],
  columns: ["rank", "type", "title", "author", "votes", "excerpt", "url"],
  func: async (page, kwargs) => {
    const { id, offset = 0, limit = 20 } = kwargs;
    const collectionId = String(id);
    if (!/^\d+$/.test(collectionId)) {
      throw new ArgumentError("Collection ID must be numeric", "Example: opencli zhihu collection 83283292");
    }
    const pageOffset = validateNonNegativeInt(offset, "offset");
    const requestedLimit = validatePositiveInt(limit, "limit");
    const pageLimit = Math.min(requestedLimit, 20);
    await page.goto("https://www.zhihu.com");
    const collected = [];
    const seen = /* @__PURE__ */ new Set();
    let totals = 0;
    let nextOffset = pageOffset;
    const maxPages = Math.ceil(requestedLimit / pageLimit) + 2;
    for (let pageIndex = 0; pageIndex < maxPages && collected.length < requestedLimit; pageIndex += 1) {
      const currentFetchLimit = Math.min(pageLimit, requestedLimit - collected.length);
      const data = await fetchCollectionPage(page, collectionId, nextOffset, currentFetchLimit);
      const items = Array.isArray(data.data) ? data.data : [];
      const paging = data.paging || {};
      totals = Number(paging.totals || totals || 0);
      for (const item of items) {
        const key = itemKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(item);
        }
        if (collected.length >= requestedLimit) break;
      }
      if (items.length === 0 || paging.is_end || collected.length >= requestedLimit) break;
      if (typeof paging.next === "string") {
        try {
          const nextUrl = new URL(paging.next);
          const parsedOffset = Number(nextUrl.searchParams.get("offset"));
          if (Number.isInteger(parsedOffset) && parsedOffset > nextOffset) {
            nextOffset = parsedOffset;
            continue;
          }
        } catch {
        }
      }
      if (items.length < currentFetchLimit) break;
      const fallbackOffset = nextOffset + items.length;
      if (fallbackOffset <= nextOffset) break;
      nextOffset = fallbackOffset;
      if (totals && nextOffset >= totals) break;
    }
    const totalPages = Math.ceil(totals / pageLimit);
    const currentPage = Math.floor(pageOffset / pageLimit) + 1;
    if (totals > 0) {
      log.info(`\u6536\u85CF\u5939\u5171\u6709 ${totals} \u6761\u5185\u5BB9\uFF0C\u5171 ${totalPages} \u9875`);
      log.info(`\u5F53\u524D\u7B2C ${currentPage} \u9875\uFF0C\u663E\u793A\u7B2C ${pageOffset + 1} - ${Math.min(pageOffset + collected.length, totals)} \u6761`);
    }
    if (collected.length === 0) {
      throw new EmptyResultError("zhihu collection", `No items found for collection ${collectionId}. The collection may be empty, private, or the offset may be out of range.`);
    }
    return collected.slice(0, requestedLimit).map((item, i) => mapCollectionItem(item, pageOffset + i + 1));
  }
});
var __test__ = {
  stripHtml,
  validatePositiveInt,
  validateNonNegativeInt,
  itemKey,
  mapCollectionItem
};
export {
  __test__
};
