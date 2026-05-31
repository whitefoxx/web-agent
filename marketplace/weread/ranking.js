// ../browser-agent/opencli/clis/weread/ranking.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/weread/utils.js
import { CliError } from "@jackwener/opencli/errors";
var WEREAD_DOMAIN = "weread.qq.com";
var WEREAD_WEB_ORIGIN = `https://${WEREAD_DOMAIN}`;
var WEREAD_SHELF_URL = `${WEREAD_WEB_ORIGIN}/web/shelf`;
var WEB_API = `${WEREAD_WEB_ORIGIN}/web`;
var API = `https://i.${WEREAD_DOMAIN}`;
var WEREAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function fetchWebApi(path, params) {
  const url = new URL(`${WEB_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": WEREAD_UA }
  });
  if (!resp.ok) {
    throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
  }
  try {
    return await resp.json();
  } catch {
    throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
  }
}

// ../browser-agent/opencli/clis/weread/ranking.js
cli({
  site: "weread",
  name: "ranking",
  access: "read",
  description: "WeRead book rankings by category",
  domain: "weread.qq.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: "category", positional: true, default: "all", help: "Category: all (default), rising, or numeric category ID" },
    { name: "limit", type: "int", default: 20, help: "Max results" }
  ],
  columns: ["rank", "title", "author", "category", "readingCount", "bookId"],
  func: async (args) => {
    const cat = encodeURIComponent(args.category ?? "all");
    const data = await fetchWebApi(`/bookListInCategory/${cat}`, { rank: "1" });
    const books = data?.books ?? [];
    return books.slice(0, Number(args.limit)).map((item, i) => ({
      rank: i + 1,
      title: item.bookInfo?.title ?? "",
      author: item.bookInfo?.author ?? "",
      category: item.bookInfo?.category ?? "",
      readingCount: item.readingCount ?? 0,
      bookId: item.bookInfo?.bookId ?? ""
    }));
  }
});
