// ../browser-agent/opencli/clis/pubmed/citations.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/pubmed/utils.js
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
var EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
var LINK_COLUMNS = ["rank", "pmid", "title", "authors", "journal", "year", "article_type", "doi", "url"];
var lastRequestAt = 0;
function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ArgumentError(`pubmed ${label} cannot be empty`);
  }
  return text;
}
function requirePmid(value, label = "pmid") {
  const pmid = requireText(value, label);
  if (!/^\d+$/.test(pmid)) {
    throw new ArgumentError(`pubmed ${label} must be a numeric PMID`, "Example: 37780221");
  }
  return pmid;
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
async function fetchSummaryRows(pmids, commandLabel) {
  const result = await eutilsFetch("esummary", { id: pmids.join(",") }, { label: commandLabel });
  return ensureCompleteSummaryRows(pmids, result, commandLabel);
}

// ../browser-agent/opencli/clis/pubmed/citations.js
cli({
  site: "pubmed",
  name: "citations",
  access: "read",
  description: "Get PubMed citation relationships for an article",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "pmid", positional: true, required: true, help: "PubMed ID, e.g. 37780221" },
    { name: "direction", default: "citedby", choices: ["citedby", "references"], help: "citedby or references" },
    { name: "limit", type: "int", default: 20, help: "Max results (1-100)" }
  ],
  columns: LINK_COLUMNS,
  func: async (args) => {
    const pmid = requirePmid(args.pmid);
    const direction = requireChoice(args.direction, ["citedby", "references"], "direction", "citedby");
    const limit = requireBoundedInt(args.limit, 20, 100);
    const linkname = direction === "citedby" ? "pubmed_pubmed_citedin" : "pubmed_pubmed_refs";
    const result = await eutilsFetch("elink", {
      id: pmid,
      dbfrom: "pubmed",
      cmd: "neighbor",
      linkname
    }, { label: "pubmed citations" });
    const links = result?.linksets?.[0]?.linksetdbs?.[0]?.links;
    if (!Array.isArray(links) || links.length === 0) {
      throw new EmptyResultError("pubmed citations", `No ${direction} links found for PMID ${pmid}.`);
    }
    return fetchSummaryRows(links.slice(0, limit).map(String), "pubmed citations summary");
  }
});
