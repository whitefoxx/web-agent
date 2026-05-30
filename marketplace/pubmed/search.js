// ../browser-agent/opencli/clis/pubmed/search.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError as CommandExecutionError2, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/pubmed/utils.js
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
var EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
var SEARCH_COLUMNS = ["rank", "pmid", "title", "authors", "journal", "year", "article_type", "doi", "url"];
var lastRequestAt = 0;
function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ArgumentError(`pubmed ${label} cannot be empty`);
  }
  return text;
}
function requireBoundedInt(value, defaultValue, maxValue, label = "limit") {
  const raw = value ?? defaultValue;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new ArgumentError(`pubmed ${label} must be a positive integer`);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ArgumentError(`pubmed ${label} must be a positive integer`);
  }
  if (n > maxValue) {
    throw new ArgumentError(`pubmed ${label} must be <= ${maxValue}`);
  }
  return n;
}
function requireYear(value, label) {
  if (value === void 0 || value === null || value === "") {
    return void 0;
  }
  const year = requireBoundedInt(value, 1900, 3e3, label);
  if (year < 1800) {
    throw new ArgumentError(`pubmed ${label} must be >= 1800`);
  }
  return year;
}
function requireChoice(value, choices, label, defaultValue) {
  const text = String(value ?? defaultValue).trim();
  if (!choices.includes(text)) {
    throw new ArgumentError(`pubmed ${label} must be one of: ${choices.join(", ")}`);
  }
  return text;
}
function buildEutilsUrl(tool, params = {}) {
  const searchParams = new URLSearchParams();
  searchParams.set("db", "pubmed");
  if (!params.retmode) {
    searchParams.set("retmode", "json");
  }
  if (process.env.NCBI_API_KEY) {
    searchParams.set("api_key", process.env.NCBI_API_KEY);
  }
  if (process.env.NCBI_EMAIL) {
    searchParams.set("email", process.env.NCBI_EMAIL);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== null && value !== "") {
      searchParams.set(key, String(value));
    }
  }
  return `${EUTILS_BASE}/${tool}.fcgi?${searchParams.toString()}`;
}
async function waitForRateLimit() {
  if (false) {
    return;
  }
  const delayMs = process.env.NCBI_API_KEY ? 110 : 360;
  const now = Date.now();
  const waitMs = Math.max(0, lastRequestAt + delayMs - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt = Date.now();
}
async function eutilsFetch(tool, params = {}, { retmode = "json", label = "PubMed E-utilities" } = {}) {
  const url = buildEutilsUrl(tool, { ...params, retmode });
  await waitForRateLimit();
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`${label} request failed`, detail);
  }
  if (!response.ok) {
    throw new CommandExecutionError(`${label} HTTP ${response.status}`, "Check NCBI availability, request parameters, and optional NCBI_API_KEY.");
  }
  if (retmode === "xml") {
    return response.text();
  }
  try {
    const json = await response.json();
    assertNoEutilsError(json, label);
    return json;
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(`${label} returned invalid JSON`, detail);
  }
}
function assertNoEutilsError(json, label = "PubMed E-utilities") {
  const error = json?.error || json?.esearchresult?.errorlist?.phrasesnotfound?.join(", ") || json?.esearchresult?.errorlist?.fieldsnotfound?.join(", ");
  if (error) {
    throw new CommandExecutionError(`${label} returned an error`, String(error));
  }
}
function buildPubMedUrl(pmid) {
  return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
}
function decodeXmlEntities(value) {
  return String(value ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
}
function cleanText(value) {
  return decodeXmlEntities(value).replace(/\s+/g, " ").trim();
}
function truncateText(value, maxLength) {
  const text = cleanText(value);
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
function extractAuthors(authorList, maxAuthors = 3) {
  if (!Array.isArray(authorList) || authorList.length === 0) {
    return "";
  }
  const names = authorList.map((author) => author?.name || author?.collectivename || [author?.lastname, author?.initials].filter(Boolean).join(" ")).filter(Boolean);
  const shown = names.slice(0, maxAuthors);
  if (names.length > maxAuthors) {
    shown.push("et al.");
  }
  return shown.join(", ");
}
function extractDoi(articleIds) {
  if (!Array.isArray(articleIds)) {
    return "";
  }
  const doi = articleIds.find((id) => String(id?.idtype ?? "").toLowerCase() === "doi");
  return String(doi?.value ?? "").trim();
}
function articleTypeFromList(types) {
  const values = Array.isArray(types) ? types.map((type) => typeof type === "string" ? type : type?.value).filter(Boolean) : [];
  const priority = ["Systematic Review", "Meta-Analysis", "Review", "Randomized Controlled Trial", "Clinical Trial", "Case Reports", "Journal Article"];
  for (const wanted of priority) {
    const found = values.find((type) => type.toLowerCase() === wanted.toLowerCase());
    if (found) {
      return found;
    }
  }
  return values[0] || "Journal Article";
}
function summaryToRow(article, rank, pmid = article?.uid) {
  const id = String(pmid ?? article?.uid ?? "").trim();
  return {
    rank,
    pmid: id,
    title: truncateText(String(article?.title ?? "").replace(/\.$/, ""), 120),
    authors: extractAuthors(article?.authors, 3),
    journal: truncateText(article?.fulljournalname || article?.source || "", 60),
    year: String(article?.pubdate ?? "").split(" ")[0] || "",
    article_type: articleTypeFromList(article?.pubtype),
    doi: extractDoi(article?.articleids),
    url: buildPubMedUrl(id)
  };
}
function ensureCompleteSummaryRows(pmids, result, commandLabel) {
  if (!result || typeof result !== "object" || !result.result || typeof result.result !== "object") {
    throw new CommandExecutionError(`${commandLabel} returned an unreadable summary payload`);
  }
  const rows = pmids.map((pmid, index) => {
    const article = result.result[pmid];
    if (!article) {
      return null;
    }
    return summaryToRow(article, index + 1, pmid);
  });
  if (rows.some((row) => row === null)) {
    throw new CommandExecutionError(`${commandLabel} omitted summaries for one or more PMIDs`, "Refusing to return a partial result set.");
  }
  return rows;
}
function buildSearchQuery(query, filters = {}) {
  const terms = [requireText(query, "query")];
  if (filters.author) terms.push(`${requireText(filters.author, "author")}[Author]`);
  if (filters.journal) terms.push(`${requireText(filters.journal, "journal")}[Journal]`);
  if (filters.yearFrom || filters.yearTo) {
    const from = filters.yearFrom || 1800;
    const to = filters.yearTo || (/* @__PURE__ */ new Date()).getFullYear();
    if (from > to) {
      throw new ArgumentError("pubmed year-from must be <= year-to");
    }
    terms.push(`${from}:${to}[PDAT]`);
  }
  if (filters.articleType) terms.push(`${requireText(filters.articleType, "article-type")}[PT]`);
  if (filters.hasAbstract) terms.push("hasabstract[text]");
  if (filters.hasFullText) terms.push("free full text[sb]");
  if (filters.humanOnly) terms.push("humans[mesh]");
  if (filters.englishOnly) terms.push("english[lang]");
  return terms.join(" AND ");
}
async function fetchSummaryRows(pmids, commandLabel) {
  const result = await eutilsFetch("esummary", { id: pmids.join(",") }, { label: commandLabel });
  return ensureCompleteSummaryRows(pmids, result, commandLabel);
}

// ../browser-agent/opencli/clis/pubmed/search.js
cli({
  site: "pubmed",
  name: "search",
  access: "read",
  description: "Search PubMed articles with advanced filters",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", positional: true, required: true, help: 'Search query, e.g. "machine learning cancer"' },
    { name: "limit", type: "int", default: 20, help: "Max results (1-100)" },
    { name: "author", help: "Filter by author name" },
    { name: "journal", help: "Filter by journal name" },
    { name: "year-from", type: "int", help: "Filter publication year from" },
    { name: "year-to", type: "int", help: "Filter publication year to" },
    { name: "article-type", help: "Filter by publication type, e.g. Review or Clinical Trial" },
    { name: "has-abstract", type: "boolean", default: false, help: "Only include articles with abstracts" },
    { name: "free-full-text", type: "boolean", default: false, help: "Only include free full text articles" },
    { name: "humans-only", type: "boolean", default: false, help: "Only include human studies" },
    { name: "english-only", type: "boolean", default: false, help: "Only include English articles" },
    { name: "sort", default: "relevance", choices: ["relevance", "date", "author", "journal"], help: "Sort by relevance, date, author, or journal" }
  ],
  columns: SEARCH_COLUMNS,
  func: async (args) => {
    const query = requireText(args.query, "query");
    const limit = requireBoundedInt(args.limit, 20, 100);
    const yearFrom = requireYear(args["year-from"], "year-from");
    const yearTo = requireYear(args["year-to"], "year-to");
    const sort = requireChoice(args.sort, ["relevance", "date", "author", "journal"], "sort", "relevance");
    const sortMap = {
      relevance: "",
      date: "pub_date",
      author: "Author",
      journal: "JournalName"
    };
    const searchQuery = buildSearchQuery(query, {
      author: args.author,
      journal: args.journal,
      yearFrom,
      yearTo,
      articleType: args["article-type"],
      hasAbstract: args["has-abstract"],
      hasFullText: args["free-full-text"],
      humanOnly: args["humans-only"],
      englishOnly: args["english-only"]
    });
    const esearch = await eutilsFetch("esearch", {
      term: searchQuery,
      retmax: limit,
      usehistory: "y",
      sort: sortMap[sort]
    }, { label: "pubmed search" });
    const pmids = esearch?.esearchresult?.idlist;
    if (!Array.isArray(pmids)) {
      throw new CommandExecutionError2("pubmed search did not return an id list", "PubMed ESearch response shape may have changed.");
    }
    if (pmids.length === 0) {
      throw new EmptyResultError("pubmed search", `No articles matched "${query}".`);
    }
    return fetchSummaryRows(pmids, "pubmed search summary");
  }
});
