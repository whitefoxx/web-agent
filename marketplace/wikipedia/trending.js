// ../browser-agent/opencli/clis/wikipedia/trending.js
import { CliError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/wikipedia/utils.js

var DESC_MAX_LEN = 80;
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

// ../browser-agent/opencli/clis/wikipedia/trending.js
cli({
  site: "wikipedia",
  name: "trending",
  access: "read",
  description: "Most-read Wikipedia articles (yesterday)",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "limit", type: "int", default: 10, help: "Max results" },
    { name: "lang", default: "en", help: "Language code (e.g. en, zh, ja)" }
  ],
  columns: ["rank", "title", "description", "views"],
  func: async (args) => {
    const lang = args.lang || "en";
    const limit = Math.max(1, Math.min(Number(args.limit), 50));
    const d = new Date(Date.now() - 864e5);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const data = await wikiFetch(lang, `/api/rest_v1/feed/featured/${yyyy}/${mm}/${dd}`);
    const articles = data?.mostread?.articles;
    if (!articles?.length)
      throw new CliError("NOT_FOUND", "No trending articles available", "Try a different language with --lang");
    const selectedArticles = articles.slice(0, limit);
    if (selectedArticles.some((article) => !String(article?.title || "").trim())) {
      throw new CliError("PARSE_ERROR", "Wikipedia trending returned an article without title", "Trending rows require a title so they can be opened with wikipedia page.");
    }
    return selectedArticles.map((a, i) => ({
      rank: i + 1,
      title: a.title,
      description: (a.description ?? "").slice(0, DESC_MAX_LEN),
      views: a.views ?? 0
    }));
  }
});
