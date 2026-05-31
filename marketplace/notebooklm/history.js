// ../browser-agent/opencli/clis/notebooklm/history.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CliError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
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
var NOTEBOOKLM_HISTORY_THREADS_RPC_ID = "hPTbtc";
var NOTEBOOKLM_HISTORY_DETAIL_RPC_ID = "khqZz";
function normalizeNotebooklmTitle(value, fallback = "") {
  if (typeof value !== "string")
    return fallback;
  let normalized = value.replace(/\s+/g, " ").trim();
  if (/^Untitled\b/i.test(normalized) && /otebook$/i.test(normalized) && normalized !== "Untitled notebook") {
    normalized = "Untitled notebook";
  }
  return normalized || fallback;
}
function isNotebooklmUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function collectNotebooklmStrings(value, results) {
  if (typeof value === "string") {
    const normalized = normalizeNotebooklmTitle(value);
    if (!normalized)
      return results;
    if (isNotebooklmUuid(normalized))
      return results;
    if (/^[\d\s]+$/.test(normalized))
      return results;
    if (/^(null|undefined)$/i.test(normalized))
      return results;
    results.push(normalized);
    return results;
  }
  if (!Array.isArray(value))
    return results;
  for (const item of value)
    collectNotebooklmStrings(item, results);
  return results;
}
function collectNotebooklmThreadIds(value, results, seen) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (isNotebooklmUuid(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
    return results;
  }
  if (!Array.isArray(value))
    return results;
  for (const item of value)
    collectNotebooklmThreadIds(item, results, seen);
  return results;
}
function parseNotebooklmHistoryThreadIdsResult(result) {
  return collectNotebooklmThreadIds(result, [], /* @__PURE__ */ new Set());
}
function extractNotebooklmHistoryPreview(result) {
  const strings = collectNotebooklmStrings(result, []);
  return strings.length > 0 ? strings[0] : null;
}
async function listNotebooklmHistoryViaRpc(page) {
  const state = await getNotebooklmPageState(page);
  if (state.kind !== "notebook" || !state.notebookId)
    return [];
  const threadsRpc = await callNotebooklmRpc(page, NOTEBOOKLM_HISTORY_THREADS_RPC_ID, [[], null, state.notebookId, 20]);
  const threadIds = parseNotebooklmHistoryThreadIdsResult(threadsRpc.result);
  if (threadIds.length === 0)
    return [];
  const rows = [];
  for (const threadId of threadIds) {
    const detailRpc = await callNotebooklmRpc(page, NOTEBOOKLM_HISTORY_DETAIL_RPC_ID, [[], null, null, threadId, 20]);
    rows.push({
      notebook_id: state.notebookId,
      thread_id: threadId,
      item_count: Array.isArray(detailRpc.result) ? detailRpc.result.length : 0,
      preview: extractNotebooklmHistoryPreview(detailRpc.result),
      url: state.url || `https://${NOTEBOOKLM_DOMAIN}/notebook/${state.notebookId}`,
      source: "rpc"
    });
  }
  return rows;
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

// ../browser-agent/opencli/clis/notebooklm/history.js
cli({
  site: NOTEBOOKLM_SITE,
  name: "history",
  access: "read",
  description: "List NotebookLM conversation history threads in the current notebook",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [],
  columns: ["thread_id", "item_count", "preview", "source", "notebook_id", "url"],
  func: async (page) => {
    await requireNotebooklmSession(page);
    const state = await getNotebooklmPageState(page);
    if (state.kind !== "notebook") {
      throw new EmptyResultError("opencli notebooklm history", "No NotebookLM notebook is open in the adapter session. Run `opencli notebooklm open <notebook>` first.");
    }
    const rows = await listNotebooklmHistoryViaRpc(page);
    return rows;
  }
});
