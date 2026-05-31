// ../browser-agent/opencli/clis/notebooklm/notes-get.js
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
function normalizeNotebooklmTitle(value, fallback = "") {
  if (typeof value !== "string")
    return fallback;
  let normalized = value.replace(/\s+/g, " ").trim();
  if (/^Untitled\b/i.test(normalized) && /otebook$/i.test(normalized) && normalized !== "Untitled notebook") {
    normalized = "Untitled notebook";
  }
  return normalized || fallback;
}
function parseNotebooklmNoteListRawRows(rows, notebookId, url) {
  const parsed = rows.map((row) => {
    const title = normalizeNotebooklmTitle(row.title, "");
    const text = String(row.text ?? "").replace(/\bsticky_note_2\b/g, " ").replace(/\bmore_vert\b/g, " ").replace(/\s+/g, " ").trim();
    if (!title)
      return null;
    const suffix = text.startsWith(title) ? text.slice(title.length).trim() : text.replace(title, "").trim();
    return {
      notebook_id: notebookId,
      title,
      created_at: suffix || null,
      url,
      source: "studio-list"
    };
  });
  return parsed.filter((row) => row !== null);
}
function parseNotebooklmVisibleNoteRawRow(row, notebookId, url) {
  const title = normalizeNotebooklmTitle(row?.title, "");
  const content = String(row?.content ?? "").replace(/\r\n/g, "\n").trim();
  if (!title)
    return null;
  return {
    notebook_id: notebookId,
    id: null,
    title,
    content,
    url,
    source: "studio-editor"
  };
}
function findNotebooklmNoteRow(rows, query) {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return null;
  const exactTitle = rows.find((row) => row.title.trim().toLowerCase() === needle);
  if (exactTitle)
    return exactTitle;
  const partialMatches = rows.filter((row) => row.title.trim().toLowerCase().includes(needle));
  if (partialMatches.length === 1)
    return partialMatches[0];
  return null;
}
async function listNotebooklmNotesFromPage(page) {
  const state = await getNotebooklmPageState(page);
  if (state.kind !== "notebook" || !state.notebookId)
    return [];
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    return Array.from(document.querySelectorAll('artifact-library-note')).map((node) => {
      const titleNode = node.querySelector('.artifact-title');
      return {
        title: (titleNode?.textContent || '').trim(),
        text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim(),
      };
    });
  })()`));
  if (!Array.isArray(raw) || raw.length === 0)
    return [];
  return parseNotebooklmNoteListRawRows(raw, state.notebookId, state.url || `https://${NOTEBOOKLM_DOMAIN}/notebook/${state.notebookId}`);
}
async function readNotebooklmVisibleNoteFromPage(page) {
  const state = await getNotebooklmPageState(page);
  if (state.kind !== "notebook" || !state.notebookId)
    return null;
  const raw = unwrapNotebooklmEvaluateResult(await page.evaluate(`(() => {
    const normalizeText = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\r\\n/g, '\\n').trim();
    const titleNode = document.querySelector('.note-header__editable-title');
    const title = titleNode instanceof HTMLInputElement || titleNode instanceof HTMLTextAreaElement
      ? titleNode.value
      : (titleNode?.textContent || '');
    const editor = document.querySelector('.note-editor .ql-editor, .note-editor [contenteditable="true"], .note-editor textarea');
    let content = '';
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      content = editor.value || '';
    } else if (editor) {
      content = editor.innerText || editor.textContent || '';
    }
    return {
      title: normalizeText(title),
      content: normalizeText(content),
    };
  })()`));
  return parseNotebooklmVisibleNoteRawRow(raw, state.notebookId, state.url || `https://${NOTEBOOKLM_DOMAIN}/notebook/${state.notebookId}`);
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

// ../browser-agent/opencli/clis/notebooklm/notes-get.js
function matchesNoteTitle(title, query) {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return false;
  const normalized = title.trim().toLowerCase();
  return normalized === needle || normalized.includes(needle);
}
cli({
  site: NOTEBOOKLM_SITE,
  name: "notes-get",
  access: "read",
  description: "Get one note from the current NotebookLM notebook by title from the visible note editor",
  domain: NOTEBOOKLM_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    {
      name: "note",
      positional: true,
      required: true,
      help: "Note title or id from the current notebook"
    }
  ],
  columns: ["title", "content", "source", "url"],
  func: async (page, kwargs) => {
    await requireNotebooklmSession(page);
    const state = await getNotebooklmPageState(page);
    if (state.kind !== "notebook") {
      throw new EmptyResultError("opencli notebooklm notes-get", "No NotebookLM notebook is open in the adapter session. Run `opencli notebooklm open <notebook>` first.");
    }
    const query = typeof kwargs.note === "string" ? kwargs.note : String(kwargs.note ?? "");
    const visible = await readNotebooklmVisibleNoteFromPage(page);
    if (visible && matchesNoteTitle(visible.title, query))
      return [visible];
    const rows = await listNotebooklmNotesFromPage(page);
    const listed = findNotebooklmNoteRow(rows, query);
    if (listed) {
      throw new EmptyResultError("opencli notebooklm notes-get", `Note "${query}" is listed in Studio, but opencli currently reads note content only from the visible note editor. Open that note in NotebookLM, then retry.`);
    }
    throw new EmptyResultError("opencli notebooklm notes-get", `Note "${query}" was not found in the current notebook.`);
  }
});
