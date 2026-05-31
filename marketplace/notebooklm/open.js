// ../browser-agent/opencli/clis/notebooklm/open.js
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
function buildNotebooklmNotebookUrl(notebookId) {
  const u = new URL(`/notebook/${encodeURIComponent(notebookId)}`, NOTEBOOKLM_HOME_URL);
  const authuser = getNotebooklmAuthuser();
  if (authuser) u.searchParams.set("authuser", authuser);
  return u.toString();
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

// ../browser-agent/opencli/clis/notebooklm/open.js
cli({
  site: NOTEBOOKLM_SITE,
  name: "open",
  access: "read",
  aliases: ["select"],
  description: "Open one NotebookLM notebook in the adapter session by id or URL",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: "notebook",
      positional: true,
      required: true,
      help: "Notebook id from list output, or a full NotebookLM notebook URL"
    }
  ],
  columns: ["id", "title", "url", "source"],
  func: async (page, kwargs) => {
    const notebookId = parseNotebooklmNotebookTarget(String(kwargs.notebook ?? ""));
    await page.goto(buildNotebooklmNotebookUrl(notebookId));
    await page.wait(2);
    await requireNotebooklmSession(page);
    const state = await getNotebooklmPageState(page);
    if (state.kind !== "notebook") {
      throw new CliError("NOTEBOOKLM_OPEN_FAILED", `NotebookLM notebook "${notebookId}" did not open in the adapter session`, "Run `opencli notebooklm list -f json` first and pass a valid notebook id.");
    }
    if (state.notebookId !== notebookId) {
      console.warn(`[notebooklm open] expected notebook "${notebookId}" but page reports "${state.notebookId}"; continuing`);
    }
    const current = await readCurrentNotebooklm(page);
    if (!current) {
      throw new EmptyResultError("opencli notebooklm open", "NotebookLM notebook metadata was not found after navigation.");
    }
    return [current];
  }
});
