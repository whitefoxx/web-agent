// ../browser-agent/opencli/clis/wikipedia/random.js
import { CliError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/wikipedia/utils.js

var EXTRACT_MAX_LEN = 300;
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
function formatSummaryRow(data, lang) {
  return {
    title: data.title,
    description: data.description ?? "-",
    extract: (data.extract ?? "").slice(0, EXTRACT_MAX_LEN),
    url: data.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org`
  };
}

// ../browser-agent/opencli/clis/wikipedia/random.js
cli({
  site: "wikipedia",
  name: "random",
  access: "read",
  description: "Get a random Wikipedia article",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: "lang", default: "en", help: "Language code (e.g. en, zh, ja)" }],
  columns: ["title", "description", "extract", "url"],
  func: async (args) => {
    const lang = args.lang || "en";
    const data = await wikiFetch(lang, "/api/rest_v1/page/random/summary");
    if (!data?.title)
      throw new CliError("NOT_FOUND", "No random article returned", "Try again");
    return [formatSummaryRow(data, lang)];
  }
});
