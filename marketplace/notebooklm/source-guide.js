// ../browser-agent/opencli/clis/notebooklm/source-guide.js
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
var NOTEBOOKLM_NOTEBOOK_DETAIL_RPC_ID = "rLM1Ne";
function unwrapNotebooklmSingletonResult(result) {
  let current = result;
  while (Array.isArray(current) && current.length === 1 && Array.isArray(current[0])) {
    current = current[0];
  }
  return current;
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
function parseNotebooklmSourceGuideResult(result, source) {
  if (!Array.isArray(result) || result.length === 0 || !Array.isArray(result[0]))
    return null;
  const outer = result[0];
  const guide = Array.isArray(outer) && outer.length > 0 && Array.isArray(outer[0]) ? outer[0] : outer;
  if (!Array.isArray(guide))
    return null;
  const summary = Array.isArray(guide[1]) && typeof guide[1][0] === "string" ? guide[1][0].trim() : "";
  const keywords = Array.isArray(guide[2]) && Array.isArray(guide[2][0]) ? guide[2][0].filter((item) => typeof item === "string" && item.trim().length > 0) : [];
  if (!summary)
    return null;
  return {
    source_id: source.id,
    notebook_id: source.notebook_id,
    title: source.title,
    type: source.type ?? null,
    summary,
    keywords,
    source: "rpc"
  };
}
function findNotebooklmSourceRow(rows, query) {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return null;
  const exactId = rows.find((row) => row.id.trim().toLowerCase() === needle);
  if (exactId)
    return exactId;
  const exactTitle = rows.find((row) => row.title.trim().toLowerCase() === needle);
  if (exactTitle)
    return exactTitle;
  const partialMatches = rows.filter((row) => row.title.trim().toLowerCase().includes(needle));
  if (partialMatches.length === 1)
    return partialMatches[0];
  return null;
}
async function listNotebooklmSourcesViaRpc(page) {
  const state = await getNotebooklmPageState(page);
  if (state.kind !== "notebook" || !state.notebookId)
    return [];
  const rpc = await callNotebooklmRpc(page, NOTEBOOKLM_NOTEBOOK_DETAIL_RPC_ID, [state.notebookId, null, [2], null, 0]);
  return parseNotebooklmSourceListResult(rpc.result);
}
async function getNotebooklmSourceGuideViaRpc(page, source) {
  if (!source.id)
    return null;
  const rpc = await callNotebooklmRpc(page, "tr032e", [[[[source.id]]]]);
  return parseNotebooklmSourceGuideResult(rpc.result, source);
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
async function listNotebooklmSourcesFromPage(page) {
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const notebookMatch = window.location.href.match(/\\/notebook\\/([^/?#]+)/);
    const notebookId = notebookMatch ? notebookMatch[1] : '';
    if (!notebookId) return [];

    const skip = new Set([
      '选择所有来源',
      '添加来源',
      '收起来源面板',
      '更多',
      'Web',
      'Fast Research',
      '提交',
      '创建笔记本',
      '分享笔记本',
      '设置',
      '对话选项',
      '配置笔记本',
      '音频概览',
      '演示文稿',
      '视频概览',
      '思维导图',
      '报告',
      '闪卡',
      '测验',
      '信息图',
      '数据表格',
      '添加笔记',
      '保存到笔记',
      '复制摘要',
      '摘要很棒',
      '摘要欠佳',
    ]);

    const rows = [];
    const seen = new Set();
    for (const node of Array.from(document.querySelectorAll('button, [role="button"], input[type="checkbox"]'))) {
      const text = (node.getAttribute?.('aria-label') || node.textContent || '').trim();
      if (!text || skip.has(text) || seen.has(text)) continue;
      if (text.includes('个来源') || text.includes('来源') && text.length < 5) continue;
      seen.add(text);
      rows.push({
        id: text,
        notebook_id: notebookId,
        title: text,
        url: window.location.href,
        source: 'current-page',
      });
    }
    return rows;
  })()`));
  if (!Array.isArray(raw))
    return [];
  return raw.filter((row) => row.id && row.title);
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

// ../browser-agent/opencli/clis/notebooklm/source-guide.js
cli({
  site: NOTEBOOKLM_SITE,
  name: "source-guide",
  access: "read",
  description: "Get the guide summary and keywords for one source in the currently opened NotebookLM notebook",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: "source",
      positional: true,
      required: true,
      help: "Source id or title from the current notebook"
    }
  ],
  columns: ["source_id", "notebook_id", "title", "type", "summary", "keywords", "source"],
  func: async (page, kwargs) => {
    await requireNotebooklmSession(page);
    const state = await getNotebooklmPageState(page);
    if (state.kind !== "notebook") {
      throw new EmptyResultError("opencli notebooklm source-guide", "No NotebookLM notebook is open in the adapter session. Run `opencli notebooklm open <notebook>` first.");
    }
    const rpcRows = await listNotebooklmSourcesViaRpc(page).catch(() => []);
    const rows = rpcRows.length > 0 ? rpcRows : await listNotebooklmSourcesFromPage(page);
    if (rows.length === 0) {
      throw new EmptyResultError("opencli notebooklm source-guide", "No NotebookLM sources were found on the current page.");
    }
    const query = typeof kwargs.source === "string" ? kwargs.source : String(kwargs.source ?? "");
    const matched = findNotebooklmSourceRow(rows, query);
    if (!matched) {
      throw new EmptyResultError("opencli notebooklm source-guide", `Source "${query}" was not found in the current notebook.`);
    }
    const guide = await getNotebooklmSourceGuideViaRpc(page, matched).catch(() => null);
    if (guide)
      return [guide];
    throw new EmptyResultError("opencli notebooklm source-guide", `NotebookLM guide was not available for source "${matched.title}".`);
  }
});
