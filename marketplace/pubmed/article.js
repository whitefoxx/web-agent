// ../browser-agent/opencli/clis/pubmed/article.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError as CommandExecutionError2, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/pubmed/utils.js
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
var EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
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
function extractFirst(xml, tag) {
  const match = String(xml ?? "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? cleanText(match[1].replace(/<[^>]+>/g, " ")) : "";
}
function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let match;
  while ((match = re.exec(String(xml ?? ""))) !== null) {
    out.push(cleanText(match[1].replace(/<[^>]+>/g, " ")));
  }
  return out;
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
function parseArticleXml(xml, pmid) {
  const text = String(xml ?? "");
  if (!text || /<ERROR\b/i.test(text) || !/<PubmedArticle\b/i.test(text)) {
    return null;
  }
  const articleBlock = text.match(/<Article\b[^>]*>([\s\S]*?)<\/Article>/i)?.[1] || text;
  const journalBlock = articleBlock.match(/<Journal\b[^>]*>([\s\S]*?)<\/Journal>/i)?.[1] || "";
  const journalIssue = journalBlock.match(/<JournalIssue\b[^>]*>([\s\S]*?)<\/JournalIssue>/i)?.[1] || "";
  const pubDate = journalIssue.match(/<PubDate\b[^>]*>([\s\S]*?)<\/PubDate>/i)?.[1] || "";
  const authorBlocks = [...text.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/gi)].map((match) => match[1]);
  const authors = authorBlocks.map((block) => {
    const name = extractFirst(block, "CollectiveName") || [extractFirst(block, "LastName"), extractFirst(block, "ForeName") || extractFirst(block, "Initials")].filter(Boolean).join(" ");
    return name;
  }).filter(Boolean);
  const abstract = extractAll(articleBlock, "AbstractText").join(" ");
  const pubTypes = extractAll(articleBlock, "PublicationType");
  const meshTerms = extractAll(text, "DescriptorName");
  const keywords = extractAll(text, "Keyword");
  const doi = text.match(/<ArticleId\b[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/i)?.[1] || "";
  const pmc = text.match(/<ArticleId\b[^>]*IdType="pmc"[^>]*>([\s\S]*?)<\/ArticleId>/i)?.[1] || "";
  return {
    pmid,
    title: extractFirst(articleBlock, "ArticleTitle"),
    abstract,
    authors,
    journal: extractFirst(journalBlock, "Title") || extractFirst(journalBlock, "ISOAbbreviation"),
    year: extractFirst(pubDate, "Year") || extractFirst(text, "MedlineDate").slice(0, 4),
    date: [extractFirst(pubDate, "Year"), extractFirst(pubDate, "Month"), extractFirst(pubDate, "Day")].filter(Boolean).join(" "),
    doi: cleanText(doi),
    pmc: cleanText(pmc),
    article_type: articleTypeFromList(pubTypes),
    language: extractFirst(articleBlock, "Language"),
    mesh_terms: meshTerms.slice(0, 10).join(", "),
    keywords: keywords.slice(0, 10).join(", "),
    url: buildPubMedUrl(pmid)
  };
}

// ../browser-agent/opencli/clis/pubmed/article.js
cli({
  site: "pubmed",
  name: "article",
  aliases: ["paper", "read"],
  access: "read",
  description: "Get detailed information for a PubMed article by PMID",
  domain: "pubmed.ncbi.nlm.nih.gov",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "pmid", positional: true, required: true, help: "PubMed ID, e.g. 37780221" },
    { name: "full-abstract", type: "boolean", default: false, help: "Do not truncate the abstract in table output" }
  ],
  columns: ["field", "value"],
  func: async (args) => {
    const pmid = requirePmid(args.pmid);
    const xml = await eutilsFetch("efetch", {
      id: pmid,
      rettype: "abstract"
    }, { retmode: "xml", label: "pubmed article" });
    const article = parseArticleXml(xml, pmid);
    if (!article) {
      throw new EmptyResultError("pubmed article", `No article found for PMID ${pmid}.`);
    }
    if (!article.title) {
      throw new CommandExecutionError2(`pubmed article ${pmid} did not include a title`, "PubMed EFetch response shape may have changed.");
    }
    const abstract = args["full-abstract"] ? article.abstract : truncateText(article.abstract, 500);
    return [
      { field: "PMID", value: article.pmid },
      { field: "Title", value: article.title },
      { field: "Authors", value: article.authors.join(", ") },
      { field: "Journal", value: article.journal },
      { field: "Year", value: article.year },
      { field: "Date", value: article.date },
      { field: "Article Type", value: article.article_type },
      { field: "Language", value: article.language },
      { field: "DOI", value: article.doi || null },
      { field: "PMC ID", value: article.pmc || null },
      { field: "MeSH Terms", value: article.mesh_terms || null },
      { field: "Keywords", value: article.keywords || null },
      { field: "Abstract", value: abstract || null },
      { field: "URL", value: article.url }
    ];
  }
});
