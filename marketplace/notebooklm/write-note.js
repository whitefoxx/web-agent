// ../browser-agent/opencli/clis/notebooklm/write-note.js
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

function parseNotebooklmIdFromUrl(url) {
  const match = url.match(/\/notebook\/([^/?#]+)/);
  return match?.[1] ?? "";
}
var NOTEBOOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ensureNotebookUuid(candidate) {
  if (!NOTEBOOK_UUID_RE.test(candidate)) {
    throw new CliError("NOTEBOOKLM_INVALID_NOTEBOOK", `NotebookLM notebook id "${candidate}" is not a valid UUID`, "Pass a notebook id from `opencli notebooklm list` or a full notebook URL like https://notebooklm.google.com/notebook/<uuid>.");
  }
  return candidate;
}
function parseNotebooklmNotebookTarget(value) {
  const normalized = value.trim();
  if (!normalized) {
    throw new CliError("NOTEBOOKLM_INVALID_NOTEBOOK", "NotebookLM notebook id is required", "Pass a notebook id from `opencli notebooklm list` or a full notebook URL.");
  }
  if (/^https?:\/\//i.test(normalized)) {
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new CliError("NOTEBOOKLM_INVALID_NOTEBOOK", "NotebookLM notebook URL is invalid", "Pass a full NotebookLM notebook URL like https://notebooklm.google.com/notebook/<uuid>.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== NOTEBOOKLM_DOMAIN || parsed.username || parsed.password || parsed.port) {
      throw new CliError("NOTEBOOKLM_INVALID_NOTEBOOK", "NotebookLM notebook URL must be a canonical https://notebooklm.google.com URL", "Pass a notebook id from `opencli notebooklm list` or a full NotebookLM notebook URL.");
    }
    const notebookId = parseNotebooklmIdFromUrl(normalized);
    if (!notebookId) {
      throw new CliError("NOTEBOOKLM_INVALID_NOTEBOOK", "NotebookLM notebook URL is invalid", "Pass a full NotebookLM notebook URL like https://notebooklm.google.com/notebook/<uuid>.");
    }
    return ensureNotebookUuid(notebookId);
  }
  const pathMatch = normalized.match(/(?:^|\/)notebook\/([^/?#]+)/);
  if (pathMatch?.[1])
    return ensureNotebookUuid(pathMatch[1]);
  return ensureNotebookUuid(normalized);
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

// ../browser-agent/opencli/clis/notebooklm/write-note.js
var NOTEBOOKLM_CREATE_NOTE_RPC_ID = "CYK0Xb";
var NOTEBOOKLM_MUTATE_NOTE_RPC_ID = "cYAfTb";
var MAX_TITLE_LEN = 200;
var MAX_CONTENT_LEN = 1e6;
var NOTE_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function parseNoteTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) throw new ArgumentError("--title is required");
  if (title.length > MAX_TITLE_LEN) {
    throw new ArgumentError(`--title must be at most ${MAX_TITLE_LEN} characters (got ${title.length})`);
  }
  return title;
}
function parseNoteContent(value) {
  const content = String(value ?? "");
  if (!content) throw new ArgumentError("--content is required");
  if (content.length > MAX_CONTENT_LEN) {
    throw new ArgumentError(`--content exceeds ${MAX_CONTENT_LEN} characters; split into smaller notes.`);
  }
  return content;
}
function buildCreateNoteShellArgs(projectId) {
  return [projectId, "", [1], null, "New Note", null, [2]];
}
function buildMutateNoteArgs(projectId, noteId, content, title) {
  return [projectId, noteId, [[[content, title, [], 0]]], [2]];
}
function toExcludedUuidSet(excludedIds) {
  return new Set(excludedIds.map((id) => String(id ?? "").toLowerCase()).filter(Boolean));
}
function parseNoteIdFromResult(result, excludedIds = []) {
  const excluded = toExcludedUuidSet(excludedIds);
  if (typeof result === "string") return NOTE_UUID_RE.test(result) && !excluded.has(result.toLowerCase()) ? result : "";
  const stack = [result];
  while (stack.length) {
    const node = stack.shift();
    if (typeof node === "string") {
      if (NOTE_UUID_RE.test(node) && !excluded.has(node.toLowerCase())) return node;
      continue;
    }
    if (Array.isArray(node)) for (const child of node) stack.push(child);
    else if (node && typeof node === "object") for (const v of Object.values(node)) stack.push(v);
  }
  return "";
}
cli({
  site: NOTEBOOKLM_SITE,
  name: "write-note",
  access: "write",
  description: "Create a Studio note in an existing NotebookLM notebook with the given title and Markdown content",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "notebook", positional: true, required: true, help: "Notebook id from `notebooklm list` or full notebook URL" },
    { name: "title", required: true, help: "Note title (1-200 chars)" },
    { name: "content", required: true, help: "Note body as Markdown" },
    { name: "execute", type: "boolean", help: "Actually create the remote NotebookLM note" }
  ],
  columns: ["notebook_id", "note_id", "title", "notebook_url"],
  func: async (page, kwargs) => {
    const notebookId = parseNotebooklmNotebookTarget(String(kwargs.notebook ?? ""));
    const title = parseNoteTitle(kwargs.title);
    const content = parseNoteContent(kwargs.content);
    requireNotebooklmExecute(kwargs.execute, "create a NotebookLM note");
    await ensureNotebooklmHome(page);
    await requireNotebooklmSession(page);
    const shellRpc = await callNotebooklmRpc(page, NOTEBOOKLM_CREATE_NOTE_RPC_ID, buildCreateNoteShellArgs(notebookId));
    const noteId = parseNoteIdFromResult(shellRpc.result, [notebookId]);
    if (!noteId) {
      throw new CommandExecutionError("NotebookLM CreateNote RPC returned no note id");
    }
    await callNotebooklmRpc(page, NOTEBOOKLM_MUTATE_NOTE_RPC_ID, buildMutateNoteArgs(notebookId, noteId, content, title));
    return [{
      notebook_id: notebookId,
      note_id: noteId,
      title,
      notebook_url: buildNotebooklmNotebookUrl(notebookId)
    }];
  }
});
var __test__ = {
  parseNoteTitle,
  parseNoteContent,
  buildCreateNoteShellArgs,
  buildMutateNoteArgs,
  parseNoteIdFromResult
};
export {
  __test__,
  buildCreateNoteShellArgs,
  buildMutateNoteArgs,
  parseNoteContent,
  parseNoteIdFromResult,
  parseNoteTitle
};
