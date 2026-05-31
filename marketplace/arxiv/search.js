// ../browser-agent/opencli/clis/arxiv/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/arxiv/utils.js

var ARXIV_BASE = "https://export.arxiv.org/api/query";
async function arxivFetch(params) {
  const resp = await fetch(`${ARXIV_BASE}?${params}`);
  if (!resp.ok) {
    throw new CommandExecutionError(`arXiv API HTTP ${resp.status}`, "Check your search term or paper ID");
  }
  return resp.text();
}
function normalizeArxivLimit(value, defaultValue, maxValue, label = "limit") {
  const raw = value ?? defaultValue;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ArgumentError(`arxiv ${label} must be a positive integer`);
  }
  if (limit > maxValue) {
    throw new ArgumentError(`arxiv ${label} must be <= ${maxValue}`);
  }
  return limit;
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : "";
}
function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null)
    results.push(m[1].trim());
  return results;
}
function extractAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`));
  return m ? m[1] : "";
}
function extractAllAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null)
    out.push(m[1]);
  return out;
}
function findLinkHref(xml, rel) {
  const re = /<link\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    if (new RegExp(`\\brel="${rel}"`).test(attrs)) {
      const h = attrs.match(/\bhref="([^"]*)"/);
      if (h)
        return h[1];
    }
  }
  return "";
}
function parseEntries(xml) {
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  const entries = [];
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const e = m[1];
    const rawId = extract(e, "id");
    const arxivId = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
    const pdf = findLinkHref(e, "related") || `https://arxiv.org/pdf/${arxivId}`;
    entries.push({
      id: arxivId,
      title: decodeEntities(extract(e, "title").replace(/\s+/g, " ")),
      authors: decodeEntities(extractAll(e, "name").join(", ")),
      abstract: decodeEntities(extract(e, "summary").replace(/\s+/g, " ")),
      published: extract(e, "published").slice(0, 10),
      updated: extract(e, "updated").slice(0, 10),
      primary_category: extractAttr(e, "arxiv:primary_category", "term"),
      categories: extractAllAttr(e, "category", "term").join(", "),
      comment: decodeEntities(extract(e, "arxiv:comment").replace(/\s+/g, " ")),
      pdf,
      url: `https://arxiv.org/abs/${arxivId}`
    });
  }
  return entries;
}

// ../browser-agent/opencli/clis/arxiv/search.js
cli({
  site: "arxiv",
  name: "search",
  access: "read",
  description: "Search arXiv papers",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", positional: true, required: true, help: 'Search keyword (e.g. "attention is all you need")' },
    { name: "limit", type: "int", default: 10, help: "Max results (max 25)" }
  ],
  columns: ["id", "title", "authors", "published", "primary_category", "url"],
  func: async (args) => {
    const queryText = String(args.query || "").trim();
    if (!queryText) {
      throw new ArgumentError("arxiv search query cannot be empty");
    }
    const limit = normalizeArxivLimit(args.limit, 10, 25);
    const query = encodeURIComponent(`all:${queryText}`);
    const xml = await arxivFetch(`search_query=${query}&max_results=${limit}&sortBy=relevance`);
    const entries = parseEntries(xml);
    if (!entries.length)
      throw new EmptyResultError("arxiv", "No papers found. Try a different keyword.");
    return entries.map((e) => ({
      id: e.id,
      title: e.title,
      authors: e.authors,
      published: e.published,
      primary_category: e.primary_category,
      url: e.url
    }));
  }
});
