// ../browser-agent/opencli/clis/weread/notes.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/weread/utils.js
import { CliError } from "@jackwener/opencli/errors";
var WEREAD_DOMAIN = "weread.qq.com";
var WEREAD_WEB_ORIGIN = `https://${WEREAD_DOMAIN}`;
var WEREAD_SHELF_URL = `${WEREAD_WEB_ORIGIN}/web/shelf`;
var WEB_API = `${WEREAD_WEB_ORIGIN}/web`;
var API = `https://i.${WEREAD_DOMAIN}`;
var WEREAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var WEREAD_AUTH_ERRCODES = /* @__PURE__ */ new Set([-2010, -2012]);
function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
function isAuthErrorResponse(resp, data) {
  return resp.status === 401 || WEREAD_AUTH_ERRCODES.has(Number(data?.errcode));
}
async function fetchPrivateApi(page, path, params) {
  const url = new URL(`${API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params))
      url.searchParams.set(k, v);
  }
  const urlStr = url.toString();
  const [apiCookies, domainCookies] = await Promise.all([
    page.getCookies({ url: urlStr }),
    page.getCookies({ domain: WEREAD_DOMAIN })
  ]);
  const merged = /* @__PURE__ */ new Map();
  for (const c of domainCookies)
    merged.set(c.name, c);
  for (const c of apiCookies)
    merged.set(c.name, c);
  const cookieHeader = buildCookieHeader(Array.from(merged.values()));
  let resp;
  try {
    resp = await fetch(urlStr, {
      headers: {
        "User-Agent": WEREAD_UA,
        "Origin": "https://weread.qq.com",
        "Referer": "https://weread.qq.com/",
        ...cookieHeader ? { "Cookie": cookieHeader } : {}
      }
    });
  } catch (error) {
    throw new CliError("FETCH_ERROR", `Failed to fetch ${path}: ${error instanceof Error ? error.message : String(error)}`, "WeRead API may be temporarily unavailable");
  }
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new CliError("PARSE_ERROR", `Invalid JSON response for ${path}`, "WeRead may have returned an HTML error page");
  }
  if (isAuthErrorResponse(resp, data)) {
    throw new CliError("AUTH_REQUIRED", "Not logged in to WeRead", "Please log in to weread.qq.com in Chrome first");
  }
  if (!resp.ok) {
    throw new CliError("FETCH_ERROR", `HTTP ${resp.status} for ${path}`, "WeRead API may be temporarily unavailable");
  }
  if (data?.errcode != null && data.errcode !== 0) {
    throw new CliError("API_ERROR", data.errmsg ?? `WeRead API error ${data.errcode}`);
  }
  return data;
}
function formatDate(ts) {
  if (!Number.isFinite(ts) || ts <= 0)
    return "-";
  const d = new Date(ts * 1e3 + 8 * 36e5);
  return d.toISOString().slice(0, 10);
}

// ../browser-agent/opencli/clis/weread/notes.js
cli({
  site: "weread",
  name: "notes",
  access: "read",
  description: "List your notes (thoughts) on a book",
  domain: "weread.qq.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "book-id", positional: true, required: true, help: "Book ID (from shelf or search results)" },
    { name: "limit", type: "int", default: 20, help: "Max results" }
  ],
  columns: ["chapter", "text", "review", "createTime"],
  func: async (page, args) => {
    const data = await fetchPrivateApi(page, "/review/list", {
      bookId: args["book-id"],
      listType: "11",
      mine: "1",
      synckey: "0"
    });
    const items = data?.reviews ?? [];
    return items.slice(0, Number(args.limit)).map((item) => ({
      chapter: item.review?.chapterName ?? "",
      text: item.review?.abstract ?? "",
      review: item.review?.content ?? "",
      createTime: formatDate(item.review?.createTime)
    }));
  }
});
