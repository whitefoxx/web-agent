// ../browser-agent/opencli/clis/wikipedia/search.js
import { CliError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/wikipedia/utils.js

async function wikiFetch(lang, path) {
  const url = `https://${lang}.wikipedia.org${path}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "opencli/1.0 (https://github.com/jackwener/opencli)" }
  });
  if (!resp.ok) {
    throw new CliError("FETCH_ERROR", `Wikipedia API HTTP ${resp.status}`, `Check your title or search term`);
  }
  return resp.json();
}

// ../browser-agent/opencli/clis/wikipedia/search.js
cli({
  site: "wikipedia",
  name: "search",
  access: "read",
  description: "Search Wikipedia articles",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "query", positional: true, required: true, help: "Search keyword" },
    { name: "limit", type: "int", default: 10, help: "Max results" },
    { name: "lang", default: "en", help: "Language code (e.g. en, zh, ja)" }
  ],
  columns: ["title", "snippet", "url"],
  func: async (args) => {
    const limit = Math.max(1, Math.min(Number(args.limit), 50));
    const lang = args.lang || "en";
    const q = encodeURIComponent(args.query);
    const data = await wikiFetch(lang, `/w/api.php?action=query&list=search&srsearch=${q}&srlimit=${limit}&format=json&utf8=1`);
    const results = data?.query?.search;
    if (!results?.length)
      throw new CliError("NOT_FOUND", "No articles found", "Try a different keyword");
    return results.map((r) => ({
      title: r.title,
      snippet: r.snippet.replace(/<[^>]+>/g, "").slice(0, 120),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`
    }));
  }
});
