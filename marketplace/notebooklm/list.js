// ../browser-agent/opencli/clis/notebooklm/list.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/notebooklm/shared.js
var NOTEBOOKLM_SITE = "notebooklm";
var NOTEBOOKLM_DOMAIN = "notebooklm.google.com";
var NOTEBOOKLM_HOME_URL = "https://notebooklm.google.com/";

// ../browser-agent/opencli/clis/notebooklm/utils.js

// ../browser-agent/opencli/clis/notebooklm/rpc.js

function unwrapNotebooklmEvaluateResult(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
function extractNotebooklmPageAuthFromHtml(html, sourcePath = "/", preferredTokens) {
  const csrfMatch = html.match(/"SNlM0e":"([^"]+)"/);
  const sessionMatch = html.match(/"FdrFJe":"([^"]+)"/);
  const csrfToken = preferredTokens?.csrfToken?.trim() || (csrfMatch ? csrfMatch[1] : "");
  const sessionId = preferredTokens?.sessionId?.trim() || (sessionMatch ? sessionMatch[1] : "");
  if (!csrfToken || !sessionId) {
    throw new CliError("NOTEBOOKLM_TOKENS", "NotebookLM page tokens were not found in the current page HTML", "Open the NotebookLM notebook page in Chrome, wait for it to finish loading, then retry with --verbose if it still fails.");
  }
  return { csrfToken, sessionId, sourcePath: sourcePath || "/", authuser: preferredTokens?.authuser ?? "" };
}
async function probeNotebooklmPageAuth(page) {
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const wiz = window.WIZ_global_data || {};
    const html = document.documentElement.innerHTML;
    const authMatch = (location.search || '').match(/[?&]authuser=(\\d+)/);
    const pathMatch = (location.pathname || '').match(/^\\/u\\/(\\d+)\\//);
    return {
      html,
      sourcePath: location.pathname || '/',
      readyState: document.readyState || '',
      csrfToken: typeof wiz.SNlM0e === 'string' ? wiz.SNlM0e : '',
      sessionId: typeof wiz.FdrFJe === 'string' ? wiz.FdrFJe : '',
      authuser: authMatch ? authMatch[1] : (pathMatch ? pathMatch[1] : ''),
    };
  })()`));
  return {
    html: String(raw?.html ?? ""),
    sourcePath: String(raw?.sourcePath ?? "/"),
    readyState: String(raw?.readyState ?? ""),
    csrfToken: String(raw?.csrfToken ?? ""),
    sessionId: String(raw?.sessionId ?? ""),
    authuser: String(raw?.authuser ?? "")
  };
}
async function getNotebooklmPageAuth(page) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const probe = await probeNotebooklmPageAuth(page);
    try {
      return extractNotebooklmPageAuthFromHtml(probe.html, probe.sourcePath, { csrfToken: probe.csrfToken, sessionId: probe.sessionId, authuser: probe.authuser });
    } catch (error) {
      lastError = error;
      if (attempt === 0 && typeof page.wait === "function") {
        await page.wait(0.5).catch(() => void 0);
        continue;
      }
    }
  }
  throw lastError;
}
function buildNotebooklmRpcBody(rpcId, params, csrfToken) {
  const rpcRequest = [[[rpcId, JSON.stringify(params), null, "generic"]]];
  return `f.req=${encodeURIComponent(JSON.stringify(rpcRequest))}&at=${encodeURIComponent(csrfToken)}&`;
}
function stripNotebooklmAntiXssi(rawBody) {
  if (!rawBody.startsWith(")]}'"))
    return rawBody;
  return rawBody.replace(/^\)\]\}'\r?\n/, "");
}
function parseNotebooklmChunkedResponse(rawBody) {
  const cleaned = stripNotebooklmAntiXssi(rawBody).trim();
  if (!cleaned)
    return [];
  const lines = cleaned.split("\n");
  const chunks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line)
      continue;
    if (/^\d+$/.test(line)) {
      const nextLine = lines[i + 1];
      if (!nextLine)
        continue;
      try {
        chunks.push(JSON.parse(nextLine));
      } catch {
      }
      i += 1;
      continue;
    }
    if (line.startsWith("[")) {
      try {
        chunks.push(JSON.parse(line));
      } catch {
      }
    }
  }
  return chunks;
}
function extractNotebooklmRpcResult(rawBody, rpcId) {
  const chunks = parseNotebooklmChunkedResponse(rawBody);
  for (const chunk of chunks) {
    if (!Array.isArray(chunk))
      continue;
    const items = Array.isArray(chunk[0]) ? chunk : [chunk];
    for (const item of items) {
      if (!Array.isArray(item) || item.length < 1)
        continue;
      if (item[0] === "er") {
        const errorCode = typeof item[2] === "number" ? item[2] : typeof item[5] === "number" ? item[5] : null;
        if (errorCode === 401 || errorCode === 403) {
          throw new AuthRequiredError(NOTEBOOKLM_DOMAIN, `NotebookLM RPC returned auth error (${errorCode})`);
        }
        throw new CliError("NOTEBOOKLM_RPC", `NotebookLM RPC failed${errorCode ? ` (code=${errorCode})` : ""}`, "Retry from an already logged-in NotebookLM session, or inspect the raw response with debug logging.");
      }
      if (item[0] === "wrb.fr" && item[1] === rpcId) {
        const payload = item[2];
        if (typeof payload === "string") {
          try {
            return JSON.parse(payload);
          } catch {
            return payload;
          }
        }
        return payload;
      }
    }
  }
  return null;
}
async function fetchNotebooklmInPage(page, url, options = {}) {
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const body = options.body ?? "";
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(async () => {
    const request = {
      url: ${JSON.stringify(url)},
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers)},
      body: ${JSON.stringify(body)},
    };

    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' ? undefined : request.body,
      credentials: 'include',
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
      finalUrl: response.url,
    };
  })()`));
  return {
    ok: Boolean(raw?.ok),
    status: Number(raw?.status ?? 0),
    body: String(raw?.body ?? ""),
    finalUrl: String(raw?.finalUrl ?? url)
  };
}
async function callNotebooklmRpc(page, rpcId, params, options = {}) {
  const auth = await getNotebooklmPageAuth(page);
  const requestBody = buildNotebooklmRpcBody(rpcId, params, auth.csrfToken);
  const authuser = auth.authuser || "";
  const url = `https://${NOTEBOOKLM_DOMAIN}/_/LabsTailwindUi/data/batchexecute?rpcids=${rpcId}&source-path=${encodeURIComponent(auth.sourcePath)}` + (authuser ? `&authuser=${encodeURIComponent(authuser)}` : "") + `&hl=${encodeURIComponent(options.hl ?? "en")}&f.sid=${encodeURIComponent(auth.sessionId)}&rt=c`;
  const response = await fetchNotebooklmInPage(page, url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: requestBody
  });
  if (response.status === 401 || response.status === 403) {
    throw new AuthRequiredError(NOTEBOOKLM_DOMAIN, `NotebookLM RPC returned auth error (${response.status})`);
  }
  if (!response.ok) {
    throw new CliError("NOTEBOOKLM_RPC", `NotebookLM RPC request failed with HTTP ${response.status}`, "Retry from the NotebookLM home page in an already logged-in Chrome session.");
  }
  return {
    auth,
    url,
    requestBody,
    response,
    result: extractNotebooklmRpcResult(response.body, rpcId)
  };
}

// ../browser-agent/opencli/clis/notebooklm/utils.js
var NOTEBOOKLM_LIST_RPC_ID = "wXbhsf";
function getNotebooklmAuthuser() {
  const v = process.env.OPENCLI_NOTEBOOKLM_AUTHUSER;
  return typeof v === "string" && /^\d+$/.test(v) ? v : "";
}
function classifyNotebooklmPage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== NOTEBOOKLM_DOMAIN)
      return "unknown";
    if (/\/notebook\/[^/?#]+/.test(parsed.pathname))
      return "notebook";
    return "home";
  } catch {
    return "unknown";
  }
}
function normalizeNotebooklmTitle(value, fallback = "") {
  if (typeof value !== "string")
    return fallback;
  let normalized = value.replace(/\s+/g, " ").trim();
  if (/^Untitled\b/i.test(normalized) && /otebook$/i.test(normalized) && normalized !== "Untitled notebook") {
    normalized = "Untitled notebook";
  }
  return normalized || fallback;
}
function normalizeNotebooklmCreatedAt(value) {
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed))
    return trimmed;
  return new Date(parsed).toISOString();
}
function toNotebooklmIsoTimestamp(epochSeconds) {
  if (typeof epochSeconds === "number" && Number.isFinite(epochSeconds)) {
    try {
      return new Date(epochSeconds * 1e3).toISOString();
    } catch {
      return null;
    }
  }
  if (Array.isArray(epochSeconds) && typeof epochSeconds[0] === "number" && Number.isFinite(epochSeconds[0])) {
    const seconds = epochSeconds[0];
    const nanos = typeof epochSeconds[1] === "number" && Number.isFinite(epochSeconds[1]) ? epochSeconds[1] : 0;
    try {
      return new Date(seconds * 1e3 + Math.floor(nanos / 1e6)).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}
function parseNotebooklmListResult(result) {
  if (!Array.isArray(result) || result.length === 0)
    return [];
  const rawNotebooks = Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rawNotebooks))
    return [];
  return rawNotebooks.filter((item) => Array.isArray(item)).map((item) => {
    const meta = Array.isArray(item[5]) ? item[5] : [];
    const timestamps = Array.isArray(meta[5]) ? meta[5] : [];
    const id = typeof item[2] === "string" ? item[2] : "";
    const title = typeof item[0] === "string" ? item[0].replace(/^thought\s*\n/, "") : "";
    return {
      id,
      title: normalizeNotebooklmTitle(title, "Untitled Notebook"),
      url: `https://${NOTEBOOKLM_DOMAIN}/notebook/${id}`,
      source: "rpc",
      is_owner: meta.length > 1 ? meta[1] === false : true,
      created_at: timestamps.length > 0 ? toNotebooklmIsoTimestamp(timestamps[0]) : null
    };
  }).filter((row) => row.id);
}
async function listNotebooklmViaRpc(page) {
  const rpc = await callNotebooklmRpc(page, NOTEBOOKLM_LIST_RPC_ID, [null, 1, null, [2]]);
  return parseNotebooklmListResult(rpc.result);
}
async function ensureNotebooklmHome(page) {
  const currentUrl = page.getCurrentUrl ? await page.getCurrentUrl().catch(() => null) : null;
  const currentKind = currentUrl ? classifyNotebooklmPage(currentUrl) : "unknown";
  if (currentKind === "home")
    return;
  const authuser = getNotebooklmAuthuser();
  const target = authuser ? `${NOTEBOOKLM_HOME_URL}?authuser=${encodeURIComponent(authuser)}` : NOTEBOOKLM_HOME_URL;
  try {
    await page.goto(target);
    await page.wait(2);
  } catch (error) {
    throw new CommandExecutionError(`Failed to open NotebookLM home: ${error?.message || error}`);
  }
}
async function getNotebooklmPageState(page) {
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const url = window.location.href;
    const title = document.title || '';
    const hostname = window.location.hostname || '';
    const notebookMatch = url.match(/\\/notebook\\/([^/?#]+)/);
    const notebookId = notebookMatch ? notebookMatch[1] : '';
    const path = window.location.pathname || '/';
    const kind = notebookId
      ? 'notebook'
      : (hostname === 'notebooklm.google.com' ? 'home' : 'unknown');

    const textNodes = Array.from(document.querySelectorAll('a, button, [role="button"], h1, h2'))
      .map(node => (node.textContent || '').trim().toLowerCase())
      .filter(Boolean);
    const loginRequired = textNodes.some(text =>
      text.includes('sign in') ||
      text.includes('log in') ||
      text.includes('登录') ||
      text.includes('登入')
    );

    const notebookCount = Array.from(document.querySelectorAll('a[href*="/notebook/"]'))
      .map(node => node instanceof HTMLAnchorElement ? node.href : '')
      .filter(Boolean)
      .reduce((count, href, index, list) => list.indexOf(href) === index ? count + 1 : count, 0);

    return { url, title, hostname, kind, notebookId, loginRequired, notebookCount, path };
  })()`));
  const state = {
    url: String(raw?.url ?? ""),
    title: normalizeNotebooklmTitle(raw?.title, "NotebookLM"),
    hostname: String(raw?.hostname ?? ""),
    kind: raw?.kind === "notebook" || raw?.kind === "home" ? raw.kind : "unknown",
    notebookId: String(raw?.notebookId ?? ""),
    loginRequired: Boolean(raw?.loginRequired),
    notebookCount: Number(raw?.notebookCount ?? 0)
  };
  if (state.hostname === NOTEBOOKLM_DOMAIN && state.loginRequired) {
    try {
      await getNotebooklmPageAuth(page);
      state.loginRequired = false;
    } catch {
    }
  }
  return state;
}
async function readCurrentNotebooklm(page) {
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const url = window.location.href;
    const match = url.match(/\\/notebook\\/([^/?#]+)/);
    if (!match) return null;

    const titleNode = document.querySelector('h1, [data-testid="notebook-title"], [role="heading"]');
    const title = (titleNode?.textContent || document.title || '').trim();
    return {
      id: match[1],
      title,
      url,
      source: 'current-page',
    };
  })()`));
  if (!raw)
    return null;
  return {
    id: String(raw.id ?? ""),
    title: normalizeNotebooklmTitle(raw.title, "Untitled Notebook"),
    url: String(raw.url ?? ""),
    source: "current-page",
    is_owner: true,
    created_at: null
  };
}
async function listNotebooklmLinks(page) {
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const rows = [];
    const seen = new Set();

    for (const node of Array.from(document.querySelectorAll('a[href*="/notebook/"]'))) {
      if (!(node instanceof HTMLAnchorElement)) continue;
      const href = node.href || '';
      const match = href.match(/\\/notebook\\/([^/?#]+)/);
      if (!match) continue;
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const parentCard = node.closest('mat-card, [role="listitem"], article, div');
      const titleNode = parentCard?.querySelector('.project-button-title, [id$="-title"]');
      const subtitleTitleNode = parentCard?.querySelector('.project-button-subtitle-part[title]');
      const subtitleTextNode = parentCard?.querySelector('.project-button-subtitle-part, .project-button-subtitle');
      const parentText = (parentCard?.textContent || '').trim();
      const parentLines = parentText
        .split(/\\n+/)
        .map((value) => value.trim())
        .filter(Boolean);

      const title = (
        titleNode?.textContent ||
        node.getAttribute('aria-label') ||
        node.getAttribute('title') ||
        parentLines.find((line) => !line.includes('个来源') && !line.includes('sources') && !line.includes('more_vert')) ||
        node.textContent ||
        ''
      ).trim();
      const createdAtHint = (
        subtitleTitleNode?.getAttribute?.('title') ||
        subtitleTextNode?.textContent ||
        ''
      ).trim();

      rows.push({
        id,
        title,
        url: href,
        source: 'home-links',
        is_owner: true,
        created_at: createdAtHint || null,
      });
    }

    return rows;
  })()`));
  if (!Array.isArray(raw))
    return [];
  return raw.map((row) => ({
    id: String(row.id ?? ""),
    title: normalizeNotebooklmTitle(row.title, "Untitled Notebook"),
    url: String(row.url ?? ""),
    source: "home-links",
    is_owner: row.is_owner === false ? false : true,
    created_at: normalizeNotebooklmCreatedAt(row.created_at)
  })).filter((row) => row.id && row.url);
}
async function requireNotebooklmSession(page) {
  const state = await getNotebooklmPageState(page);
  if (state.hostname !== NOTEBOOKLM_DOMAIN) {
    throw new CliError("NOTEBOOKLM_UNAVAILABLE", "NotebookLM page is not available in the current browser session", `Open Chrome and navigate to ${NOTEBOOKLM_HOME_URL}`);
  }
  if (state.loginRequired) {
    throw new AuthRequiredError(NOTEBOOKLM_DOMAIN, "NotebookLM requires a logged-in Google session");
  }
  return state;
}

// ../browser-agent/opencli/clis/notebooklm/list.js
cli({
  site: NOTEBOOKLM_SITE,
  name: "list",
  access: "read",
  description: "List NotebookLM notebooks via in-page batchexecute RPC in the current logged-in session",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ["title", "id", "is_owner", "created_at", "source", "url"],
  func: async (page) => {
    const currentFallback = await readCurrentNotebooklm(page).catch(() => null);
    await ensureNotebooklmHome(page);
    await requireNotebooklmSession(page);
    try {
      const rpcRows = await listNotebooklmViaRpc(page);
      if (rpcRows.length > 0)
        return rpcRows;
    } catch (error) {
      if (error instanceof AuthRequiredError)
        throw error;
    }
    const domRows = await listNotebooklmLinks(page);
    if (domRows.length > 0)
      return domRows;
    if (currentFallback)
      return [currentFallback];
    return [];
  }
});
