// ../browser-agent/opencli/clis/notebooklm/create.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/notebooklm/shared.js
var NOTEBOOKLM_SITE = "notebooklm";
var NOTEBOOKLM_DOMAIN = "notebooklm.google.com";
var NOTEBOOKLM_HOME_URL = "https://notebooklm.google.com/";

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

var NOTEBOOKLM_NOTEBOOK_DETAIL_RPC_ID = "rLM1Ne";
function unwrapNotebooklmSingletonResult(result) {
  let current = result;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }
  return current;
}
function getNotebooklmAuthuser() {
  const v = process.env.OPENCLI_NOTEBOOKLM_AUTHUSER;
  return typeof v === "string" && /^\d+$/.test(v) ? v : "";
}
function requireNotebooklmExecute(value, action) {
  if (value !== true) {
    throw new ArgumentError(`Refusing to ${action}: pass --execute to perform this NotebookLM write`);
  }
}
function buildNotebooklmNotebookUrl(notebookId) {
  const u = new URL(`/notebook/${encodeURIComponent(notebookId)}`, NOTEBOOKLM_HOME_URL);
  const authuser = getNotebooklmAuthuser();
  if (authuser) u.searchParams.set("authuser", authuser);
  return u.toString();
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
function parseNotebooklmSourceTypeCode(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value;
  if (!Array.isArray(value) || typeof value[1] !== "number" || !Number.isFinite(value[1]))
    return null;
  return value[1];
}
function parseNotebooklmSourceType(value) {
  const code = parseNotebooklmSourceTypeCode(value);
  if (code === 8)
    return "pasted-text";
  if (code === 9)
    return "youtube";
  if (code === 2)
    return "generated-text";
  if (code === 3)
    return "pdf";
  if (code === 4)
    return "audio";
  if (code === 5)
    return "web";
  if (code === 6)
    return "video";
  return code == null ? null : `type-${code}`;
}
function findFirstNotebooklmString(value) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  if (!Array.isArray(value))
    return null;
  for (const item of value) {
    const found = findFirstNotebooklmString(item);
    if (found)
      return found;
  }
  return null;
}
function parseNotebooklmNotebookDetailResult(result) {
  const detail = unwrapNotebooklmSingletonResult(result);
  if (!Array.isArray(detail) || detail.length < 3)
    return null;
  const id = typeof detail[2] === "string" ? detail[2] : "";
  if (!id)
    return null;
  const title = normalizeNotebooklmTitle(detail[0], "Untitled Notebook");
  const emoji = typeof detail[3] === "string" ? detail[3] : null;
  const meta = Array.isArray(detail[5]) ? detail[5] : [];
  const sources = Array.isArray(detail[1]) ? detail[1] : [];
  return {
    id,
    title,
    url: `https://${NOTEBOOKLM_DOMAIN}/notebook/${id}`,
    source: "rpc",
    is_owner: meta.length > 1 ? meta[1] === false : true,
    created_at: toNotebooklmIsoTimestamp(meta[8]),
    updated_at: toNotebooklmIsoTimestamp(meta[5]),
    emoji,
    source_count: sources.length
  };
}
function parseNotebooklmSourceListResult(result) {
  const detail = unwrapNotebooklmSingletonResult(result);
  const notebook = parseNotebooklmNotebookDetailResult(detail);
  if (!notebook || !Array.isArray(detail))
    return [];
  const rawSources = Array.isArray(detail[1]) ? detail[1] : [];
  return rawSources.filter((entry) => Array.isArray(entry)).map((entry) => {
    const id = findFirstNotebooklmString(entry[0]) ?? "";
    const title = normalizeNotebooklmTitle(entry[1], "Untitled source");
    const meta = Array.isArray(entry[2]) ? entry[2] : [];
    const typeInfo = typeof meta[4] === "number" ? meta[4] : entry[3];
    return {
      id,
      notebook_id: notebook.id,
      title,
      url: notebook.url,
      source: "rpc",
      type: parseNotebooklmSourceType(typeInfo),
      type_code: parseNotebooklmSourceTypeCode(typeInfo),
      size: typeof meta[1] === "number" && Number.isFinite(meta[1]) ? meta[1] : null,
      created_at: toNotebooklmIsoTimestamp(meta[2]),
      updated_at: toNotebooklmIsoTimestamp(meta[14])
    };
  }).filter((row) => row.id);
}
async function getNotebooklmNotebookDetailById(page, notebookId) {
  const rpc = await callNotebooklmRpc(page, NOTEBOOKLM_NOTEBOOK_DETAIL_RPC_ID, [notebookId, null, [2], null, 0]);
  return { detail: parseNotebooklmNotebookDetailResult(rpc.result), sources: parseNotebooklmSourceListResult(rpc.result) };
}
async function verifyNotebooklmNotebookExists(page, notebookId, action) {
  try {
    const { detail } = await getNotebooklmNotebookDetailById(page, notebookId);
    if (!detail || detail.id !== notebookId) {
      throw new CommandExecutionError(`NotebookLM ${action} succeeded but the notebook ${notebookId} was not found in the post-write verification`);
    }
    return detail;
  } catch (error) {
    if (error instanceof AuthRequiredError || error instanceof CommandExecutionError)
      throw error;
    throw new CommandExecutionError(`NotebookLM ${action} post-write verification failed: ${error?.message || error}`);
  }
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

// ../browser-agent/opencli/clis/notebooklm/create.js
var NOTEBOOKLM_CREATE_PROJECT_RPC_ID = "CCqFvf";
var DEFAULT_EMOJI = "📒";
var MAX_TITLE_LEN = 200;
var NOTEBOOK_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function parseCreateTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) throw new ArgumentError("<title> is required");
  if (title.length > MAX_TITLE_LEN) {
    throw new ArgumentError(`Title must be at most ${MAX_TITLE_LEN} characters (got ${title.length})`);
  }
  return title;
}
function parseCreateEmoji(value) {
  const emoji = String(value ?? "").trim();
  if (!emoji) return DEFAULT_EMOJI;
  return emoji;
}
function parseCreateProjectResult(result) {
  let current = result;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }
  const id = Array.isArray(current) ? typeof current[2] === "string" && current[2] || typeof current[0] === "string" && current[0] || "" : "";
  return typeof id === "string" && NOTEBOOK_UUID_RE.test(id) ? id : "";
}
cli({
  site: NOTEBOOKLM_SITE,
  name: "create",
  access: "write",
  description: "Create a new NotebookLM notebook with the given title",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "title", positional: true, required: true, help: "Notebook title (1-200 chars)" },
    { name: "emoji", help: `Notebook emoji icon (default ${DEFAULT_EMOJI})` },
    { name: "execute", type: "boolean", help: "Actually create the remote NotebookLM notebook" }
  ],
  columns: ["id", "title", "emoji", "url"],
  func: async (page, kwargs) => {
    const title = parseCreateTitle(kwargs.title);
    const emoji = parseCreateEmoji(kwargs.emoji);
    requireNotebooklmExecute(kwargs.execute, "create a NotebookLM notebook");
    await ensureNotebooklmHome(page);
    await requireNotebooklmSession(page);
    const rpc = await callNotebooklmRpc(page, NOTEBOOKLM_CREATE_PROJECT_RPC_ID, [title, emoji]);
    const notebookId = parseCreateProjectResult(rpc.result);
    if (!notebookId) {
      throw new CommandExecutionError("NotebookLM CreateProject RPC returned no notebook id");
    }
    await verifyNotebooklmNotebookExists(page, notebookId, "create");
    return [{
      id: notebookId,
      title,
      emoji,
      url: buildNotebooklmNotebookUrl(notebookId)
    }];
  }
});
var __test__ = { parseCreateTitle, parseCreateEmoji, parseCreateProjectResult };
export {
  __test__,
  parseCreateEmoji,
  parseCreateProjectResult,
  parseCreateTitle
};
