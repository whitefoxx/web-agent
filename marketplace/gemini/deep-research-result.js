// ../browser-agent/opencli/clis/gemini/deep-research-result.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/gemini/utils.js

var GEMINI_DOMAIN = "gemini.google.com";
var GEMINI_APP_URL = "https://gemini.google.com/app";
var GEMINI_RESPONSE_NOISE_PATTERNS = [
  /Gemini can make mistakes\.?/gi,
  /Google Terms/gi,
  /Google Privacy Policy/gi,
  /Opens in a new window/gi
];
var GEMINI_COMPOSER_SELECTORS = [
  '.ql-editor[contenteditable="true"]',
  '.ql-editor[role="textbox"]',
  '.ql-editor[aria-label*="Gemini"]',
  '[contenteditable="true"][aria-label*="Gemini"]',
  '[aria-label="Enter a prompt for Gemini"]',
  '[aria-label*="prompt for Gemini"]'
];
var GEMINI_COMPOSER_MARKER_ATTR = "data-opencli-gemini-composer";
function buildGeminiComposerLocatorScript() {
  const selectorsJson = JSON.stringify(GEMINI_COMPOSER_SELECTORS);
  const markerAttrJson = JSON.stringify(GEMINI_COMPOSER_MARKER_ATTR);
  return `
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const markerAttr = ${markerAttrJson};
      const clearComposerMarkers = (active) => {
        document.querySelectorAll('[' + markerAttr + ']').forEach((node) => {
          if (node !== active) node.removeAttribute(markerAttr);
        });
      };

      const markComposer = (node) => {
        if (!(node instanceof HTMLElement)) return null;
        clearComposerMarkers(node);
        node.setAttribute(markerAttr, '1');
        return node;
      };

      const findComposer = () => {
        const marked = document.querySelector('[' + markerAttr + '="1"]');
        if (marked instanceof HTMLElement && isVisible(marked)) return marked;

        const selectors = ${selectorsJson};
        for (const selector of selectors) {
          const node = Array.from(document.querySelectorAll(selector)).find((candidate) => candidate instanceof HTMLElement && isVisible(candidate));
          if (node instanceof HTMLElement) return markComposer(node);
        }
        return null;
      };
  `;
}
function parseGeminiTitleMatchMode(value, fallback = "contains") {
  const raw = String(value ?? fallback).trim().toLowerCase();
  if (raw === "contains" || raw === "exact")
    return raw;
  return null;
}
function parseGeminiConversationUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw)
    return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== GEMINI_DOMAIN && !url.hostname.endsWith(`.${GEMINI_DOMAIN}`))
      return null;
    if (!url.pathname.startsWith("/app/"))
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function normalizeGeminiTitle(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
function pickGeminiConversationByTitle(conversations, query, mode = "contains") {
  const normalizedQuery = normalizeGeminiTitle(query);
  if (!normalizedQuery)
    return null;
  for (const conversation of conversations) {
    const normalizedTitle = normalizeGeminiTitle(conversation.Title);
    if (!normalizedTitle)
      continue;
    if (mode === "exact") {
      if (normalizedTitle === normalizedQuery)
        return conversation;
      continue;
    }
    if (normalizedTitle.includes(normalizedQuery))
      return conversation;
  }
  return null;
}
function resolveGeminiConversationForQuery(conversations, query, mode) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery)
    return conversations[0] ?? null;
  const exact = pickGeminiConversationByTitle(conversations, normalizedQuery, "exact");
  if (exact)
    return exact;
  if (mode === "contains")
    return pickGeminiConversationByTitle(conversations, normalizedQuery, "contains");
  return null;
}
function sanitizeGeminiResponseText(value, promptText) {
  let sanitized = value;
  for (const pattern of GEMINI_RESPONSE_NOISE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "");
  }
  sanitized = sanitized.trim();
  const prompt = promptText.trim();
  if (!prompt)
    return sanitized;
  if (sanitized === prompt)
    return "";
  for (const separator of ["\n\n", "\n", "\r\n\r\n", "\r\n"]) {
    const prefix = `${prompt}${separator}`;
    if (sanitized.startsWith(prefix)) {
      return sanitized.slice(prefix.length).trim();
    }
  }
  return sanitized;
}
function collapseAdjacentGeminiTurns(turns) {
  const collapsed = [];
  for (const turn of turns) {
    if (!turn || typeof turn.Role !== "string" || typeof turn.Text !== "string")
      continue;
    const previous = collapsed.at(-1);
    if (previous?.Role === turn.Role && previous.Text === turn.Text)
      continue;
    collapsed.push(turn);
  }
  return collapsed;
}
function getStateScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}

      const signInNode = Array.from(document.querySelectorAll('a, button')).find((node) => {
        const text = (node.textContent || '').trim().toLowerCase();
        const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
        const href = node.getAttribute('href') || '';
        return text === 'sign in'
          || aria === 'sign in'
          || text === '登录'
          || aria === '登录'
          || href.includes('accounts.google.com/ServiceLogin');
      });

      const composer = findComposer();

      return {
        url: window.location.href,
        title: document.title || '',
        isSignedIn: signInNode ? false : (composer ? true : null),
        composerLabel: composer?.getAttribute('aria-label') || '',
        canSend: !!composer,
      };
    })()
  `;
}
function readGeminiSnapshotScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();
      const composerText = composer?.textContent?.replace(/\\u00a0/g, ' ').trim() || '';
      const isGenerating = !!Array.from(document.querySelectorAll('button, [role="button"]')).find((node) => {
        const text = (node.textContent || '').trim().toLowerCase();
        const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
        return text === 'stop response'
          || aria === 'stop response'
          || text === '停止回答'
          || aria === '停止回答';
      });
      const turns = ${getTurnsScript().trim()};
      const transcriptLines = ${getTranscriptLinesScript().trim()};

      return {
        url: window.location.href,
        turns,
        transcriptLines,
        composerHasText: composerText.length > 0,
        isGenerating,
        structuredTurnsTrusted: turns.length > 0 || transcriptLines.length === 0,
      };
    })()
  `;
}
function getTranscriptLinesScript() {
  return `
    (() => {
      const clean = (value) => (value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const main = document.querySelector('main') || document.body;
      const root = main.cloneNode(true);

      const removableSelectors = [
        'button',
        'nav',
        'header',
        'footer',
        '[aria-label="Enter a prompt for Gemini"]',
        '[aria-label*="prompt for Gemini"]',
        '.input-area-container',
        '.input-wrapper',
        '.textbox-container',
        '.ql-toolbar',
        '.send-button',
        '.main-menu-button',
        '.sign-in-button',
      ];

      for (const selector of removableSelectors) {
        root.querySelectorAll(selector).forEach((node) => node.remove());
      }
      root.querySelectorAll('script, style, noscript').forEach((node) => node.remove());

      const stopLines = new Set([
        'Gemini',
        'Google Terms',
        'Google Privacy Policy',
        'Meet Gemini, your personal AI assistant',
        'Conversation with Gemini',
        'Ask Gemini 3',
        'Write',
        'Plan',
        'Research',
        'Learn',
        'Fast',
        'send',
        'Microphone',
        'Main menu',
        'New chat',
        'Sign in',
        'Google Terms Opens in a new window',
        'Google Privacy Policy Opens in a new window',
      ]);

      const noisyPatterns = [
        /^Google Terms$/,
        /^Google Privacy Policy$/,
        /^Gemini is AI and can make mistakes.?$/,
        /^and the$/,
        /^apply.$/,
        /^Opens in a new window$/,
        /^Open mode picker$/,
        /^Open upload file menu$/,
        /^Tools$/,
      ];

      return clean(root.innerText || root.textContent || '')
        .split('\\n')
        .map((line) => clean(line))
        .filter((line) => line
          && line.length <= 4000
          && !stopLines.has(line)
          && !noisyPatterns.some((pattern) => pattern.test(line)));
    })()
  `;
}
function getTurnsScript() {
  return `
    (() => {
      const clean = (value) => (value || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const selectors = [
        '[data-testid*="message"]',
        '[data-test-id*="message"]',
        '[class*="message"]',
        '[class*="conversation-turn"]',
        '[class*="query-text"]',
        '[class*="response-text"]',
      ];

      const roots = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const unique = roots
        .filter((el, index, all) => all.indexOf(el) === index)
        .filter(isVisible)
        .sort((left, right) => {
          if (left === right) return 0;
          const relation = left.compareDocumentPosition(right);
          if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
          return 0;
        });

      const turns = unique.map((el) => {
        const text = clean(el.innerText || el.textContent || '');
        if (!text) return null;

        const roleAttr = [
          el.getAttribute('data-message-author-role'),
          el.getAttribute('data-role'),
          el.getAttribute('aria-label'),
          el.getAttribute('class'),
        ].filter(Boolean).join(' ').toLowerCase();

        let role = '';
        if (roleAttr.includes('user') || roleAttr.includes('query')) role = 'User';
        else if (roleAttr.includes('assistant') || roleAttr.includes('model') || roleAttr.includes('response') || roleAttr.includes('gemini')) role = 'Assistant';

        return role ? { Role: role, Text: text } : null;
      }).filter(Boolean);

      return turns;
    })()
  `;
}
function getGeminiConversationListScript() {
  return `
    (() => {
      const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const clampText = (value, maxLength) => {
        const normalized = normalizeText(value);
        if (!normalized) return '';
        if (normalized.length <= maxLength) return normalized;
        return normalized.slice(0, maxLength).trim();
      };

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.hidden || el.closest('[hidden]')) return false;
        const ariaHidden = el.getAttribute('aria-hidden');
        if (ariaHidden && ariaHidden.toLowerCase() === 'true') return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) === 0) return false;
        if (style.pointerEvents === 'none') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const selector = 'a[href*="/app"]';
      const navRoots = Array.from(document.querySelectorAll('nav, aside, [role="navigation"]'));
      const rootsWithLinks = navRoots.filter((root) => root.querySelector(selector));
      const roots = rootsWithLinks.length > 0 ? rootsWithLinks : [document];

      const results = [];
      const seen = new Set();
      const maxLength = 200;

      for (const root of roots) {
        const anchors = Array.from(root.querySelectorAll(selector));
        for (const anchor of anchors) {
          if (!(anchor instanceof HTMLAnchorElement)) continue;
          if (!isVisible(anchor)) continue;
          const href = anchor.getAttribute('href') || '';
          if (!href) continue;
          let url = '';
          try {
            url = new URL(href, 'https://gemini.google.com').href;
          } catch {
            continue;
          }
          if (!url) continue;
          const title = clampText(anchor.textContent || anchor.getAttribute('aria-label') || '', maxLength);
          if (!title) continue;
          const key = url + '::' + title;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push({ title, url });
        }
      }

      return results;
    })()
  `;
}
function clickGeminiConversationByTitleScript(query) {
  const normalizedQuery = normalizeGeminiTitle(query);
  return `
    ((targetQuery) => {
      const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isDisabled = (el) => {
        if (!(el instanceof HTMLElement)) return true;
        if ('disabled' in el && el.disabled) return true;
        if (el.hasAttribute('disabled')) return true;
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase();
        return ariaDisabled === 'true';
      };
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.hidden || el.closest('[hidden]')) return false;
        const ariaHidden = (el.getAttribute('aria-hidden') || '').toLowerCase();
        if (ariaHidden === 'true' || el.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const selector = 'nav a[href*="/app"], aside a[href*="/app"], [role="navigation"] a[href*="/app"], a[href*="/app"]';
      const anchors = Array.from(document.querySelectorAll(selector));

      for (const anchor of anchors) {
        if (!(anchor instanceof HTMLAnchorElement)) continue;
        if (!isVisible(anchor)) continue;
        if (isDisabled(anchor)) continue;
        const title = normalizeText(anchor.textContent || anchor.getAttribute('aria-label') || '');
        if (!title || !targetQuery) continue;
        if (!title.includes(targetQuery)) continue;
        anchor.click();
        return true;
      }
      return false;
    })(${JSON.stringify(normalizedQuery)})
  `;
}
function currentUrlScript() {
  return "window.location.href";
}
async function isOnGemini(page) {
  const url = await page.evaluate(currentUrlScript()).catch(() => "");
  if (typeof url !== "string" || !url)
    return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === GEMINI_DOMAIN || hostname.endsWith(`.${GEMINI_DOMAIN}`);
  } catch {
    return false;
  }
}
async function ensureGeminiPage(page) {
  if (!await isOnGemini(page)) {
    await page.goto(GEMINI_APP_URL, { waitUntil: "load", settleMs: 2500 });
    await page.wait(1);
  }
}
async function getCurrentGeminiUrl(page) {
  await ensureGeminiPage(page);
  const url = await page.evaluate(currentUrlScript()).catch(() => "");
  if (typeof url === "string" && url.trim())
    return url;
  return GEMINI_APP_URL;
}
async function getGeminiPageState(page) {
  await ensureGeminiPage(page);
  return await page.evaluate(getStateScript());
}
async function getGeminiConversationList(page) {
  await ensureGeminiPage(page);
  const raw = await page.evaluate(getGeminiConversationListScript());
  if (!Array.isArray(raw))
    return [];
  return raw.filter((item) => item && typeof item.title === "string" && typeof item.url === "string").map((item) => ({ Title: item.title, Url: item.url }));
}
async function clickGeminiConversationByTitle(page, query) {
  await ensureGeminiPage(page);
  const normalizedQuery = normalizeGeminiTitle(query);
  if (!normalizedQuery)
    return false;
  const clicked = await page.evaluate(clickGeminiConversationByTitleScript(normalizedQuery));
  if (clicked)
    await page.wait(1);
  return !!clicked;
}
async function getGeminiVisibleTurns(page) {
  const turns = await getGeminiStructuredTurns(page);
  if (Array.isArray(turns) && turns.length > 0)
    return turns;
  const lines = await getGeminiTranscriptLines(page);
  return lines.map((line) => ({ Role: "System", Text: line }));
}
async function getGeminiStructuredTurns(page) {
  await ensureGeminiPage(page);
  const turns = collapseAdjacentGeminiTurns(await page.evaluate(getTurnsScript()));
  return Array.isArray(turns) ? turns : [];
}
async function getGeminiTranscriptLines(page) {
  await ensureGeminiPage(page);
  return await page.evaluate(getTranscriptLinesScript());
}
async function waitForGeminiTranscript(page, attempts = 5) {
  let lines = [];
  for (let index = 0; index < attempts; index += 1) {
    lines = await getGeminiTranscriptLines(page);
    if (lines.length > 0)
      return lines;
    if (index < attempts - 1)
      await page.wait(1);
  }
  return lines;
}
async function getLatestGeminiAssistantResponse(page) {
  await ensureGeminiPage(page);
  const turns = await getGeminiVisibleTurns(page);
  const assistantTurn = [...turns].reverse().find((turn) => turn.Role === "Assistant");
  if (assistantTurn?.Text) {
    return sanitizeGeminiResponseText(assistantTurn.Text, "");
  }
  const lines = await getGeminiTranscriptLines(page);
  return lines.join("\n").trim();
}
async function readGeminiSnapshot(page) {
  await ensureGeminiPage(page);
  return await page.evaluate(readGeminiSnapshotScript());
}
function normalizeGeminiExportUrls(value) {
  if (!Array.isArray(value))
    return [];
  const seen = /* @__PURE__ */ new Set();
  const urls = [];
  for (const item of value) {
    const raw = String(item ?? "").trim();
    if (!raw || seen.has(raw))
      continue;
    seen.add(raw);
    urls.push(raw);
  }
  return urls;
}
function pickGeminiDeepResearchExportUrl(rawUrls, currentUrl) {
  let bestScore = -Infinity;
  let bestUrl = "";
  let bestSource = "none";
  const sourceWeight = {
    fetch: 50,
    xhr: 45,
    "fetch-body": 72,
    "xhr-body": 72,
    "fetch-body-docs-id": 95,
    "xhr-body-docs-id": 95,
    open: 55,
    anchor: 55,
    performance: 35
  };
  for (const rawEntry of rawUrls) {
    const match = rawEntry.match(/^([a-z-]+)::(.+)$/i);
    const sourceKey = (match?.[1] ?? "performance").toLowerCase();
    const rawUrl = (match?.[2] ?? rawEntry).trim();
    if (!rawUrl)
      continue;
    let parsedUrl = rawUrl;
    let isBlob = false;
    if (rawUrl.startsWith("blob:")) {
      isBlob = true;
    } else {
      try {
        parsedUrl = new URL(rawUrl, currentUrl).href;
      } catch {
        continue;
      }
    }
    if (!isBlob) {
      try {
        const parsed = new URL(parsedUrl);
        if (!["http:", "https:"].includes(parsed.protocol))
          continue;
      } catch {
        continue;
      }
    }
    const hasMarkdownSignal = /\.md(?:$|[?#])/i.test(parsedUrl) || /markdown/i.test(parsedUrl);
    const hasExportSignal = /export|download|attachment|file|save-report/i.test(parsedUrl);
    const isGoogleDocUrl = /docs\.google\.com\/document\//i.test(parsedUrl);
    const isGoogleSheetUrl = /docs\.google\.com\/spreadsheets\//i.test(parsedUrl);
    const isNoiseEndpoint = /cspreport|allowlist|gen_204|telemetry|metrics|analytics|doubleclick|logging|collect|favicon/i.test(parsedUrl);
    let score = sourceWeight[sourceKey] ?? 20;
    if (hasMarkdownSignal)
      score += 45;
    if (hasExportSignal)
      score += 25;
    if (isGoogleDocUrl)
      score += 100;
    if (isGoogleSheetUrl)
      score -= 160;
    if (/gemini\.google\.com\/app\//i.test(parsedUrl))
      score -= 60;
    if (/googleapis\.com|gstatic\.com|doubleclick\.net|google-analytics/i.test(parsedUrl))
      score -= 40;
    if (!hasMarkdownSignal && !hasExportSignal && !isBlob)
      score -= 40;
    if (isNoiseEndpoint)
      score -= 120;
    if (parsedUrl === currentUrl)
      score -= 80;
    if (isBlob)
      score += 25;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = parsedUrl;
      if (isBlob)
        bestSource = "blob";
      else if (sourceKey === "open")
        bestSource = "window-open";
      else if (sourceKey === "anchor")
        bestSource = "anchor";
      else if (sourceKey === "performance")
        bestSource = "performance";
      else
        bestSource = "network";
    }
  }
  if (!bestUrl || bestScore < 60) {
    return { url: "", source: "none" };
  }
  return { url: bestUrl, source: bestSource };
}
function exportGeminiDeepResearchReportScript(maxWaitMs) {
  return `
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const labels = {
        actionMenu: ['open menu for conversation actions', 'conversation actions', '会话操作'],
        share: ['share & export', 'share and export', 'share/export', '分享与导出', '分享和导出', '分享并导出', '共享和导出'],
        shareConversation: ['share conversation', '分享会话', '分享对话'],
        export: ['export', '导出'],
        exportDocs: ['export to docs', 'export to google docs', 'export to doc', '导出到 docs', '导出到文档', '导出到 google docs'],
      };

      const recorderKey = '__opencliGeminiExportUrls';
      const patchedKey = '__opencliGeminiExportPatched';
      const trace = [];
      const tracePush = (step, detail = '') => {
        const entry = detail ? step + ':' + detail : step;
        trace.push(entry);
        if (trace.length > 80) trace.shift();
      };

      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const normalizeLabels = (values) => {
        if (!Array.isArray(values)) return [];
        return values.map((value) => normalize(value)).filter(Boolean);
      };
      const includesAny = (value, candidates) => {
        const text = normalize(value);
        if (!text) return false;
        return candidates.some((candidate) => text.includes(candidate));
      };
      const labelsNormalized = {
        actionMenu: normalizeLabels(labels.actionMenu),
        share: normalizeLabels(labels.share),
        shareConversation: normalizeLabels(labels.shareConversation),
        export: normalizeLabels(labels.export),
        exportDocs: normalizeLabels(labels.exportDocs),
      };

      const queryAllDeep = (roots, selector) => {
        const seed = Array.isArray(roots) && roots.length > 0 ? roots : [document];
        const seenScopes = new Set();
        const seenElements = new Set();
        const out = [];
        const queue = [...seed];
        while (queue.length > 0) {
          const scope = queue.shift();
          const isValidScope = scope === document
            || scope instanceof Document
            || scope instanceof Element
            || scope instanceof ShadowRoot;
          if (!isValidScope || seenScopes.has(scope)) continue;
          seenScopes.add(scope);

          let nodes = [];
          try {
            nodes = Array.from(scope.querySelectorAll(selector));
          } catch {}

          for (const node of nodes) {
            if (!(node instanceof Element)) continue;
            if (!seenElements.has(node)) {
              seenElements.add(node);
              out.push(node);
            }
            if (node.shadowRoot) queue.push(node.shadowRoot);
          }

          let descendants = [];
          try {
            descendants = Array.from(scope.querySelectorAll('*'));
          } catch {}
          for (const child of descendants) {
            if (child instanceof Element && child.shadowRoot) queue.push(child.shadowRoot);
          }
        }
        return out;
      };

      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.hidden || el.closest('[hidden]')) return false;
        const ariaHidden = (el.getAttribute('aria-hidden') || '').toLowerCase();
        if (ariaHidden === 'true' || el.closest('[aria-hidden="true"]')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number(style.opacity) === 0 || style.pointerEvents === 'none') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const isDisabled = (el) => {
        if (!(el instanceof HTMLElement)) return true;
        if ('disabled' in el && el.disabled) return true;
        if (el.hasAttribute('disabled')) return true;
        return (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      };
      const isInteractable = (el) => isVisible(el) && !isDisabled(el);
      const textOf = (node) => [
        node?.textContent || '',
        node instanceof HTMLElement ? (node.innerText || '') : '',
        node?.getAttribute?.('aria-label') || '',
        node?.getAttribute?.('title') || '',
        node?.getAttribute?.('data-tooltip') || '',
        node?.getAttribute?.('mattooltip') || '',
      ].join(' ');
      const hasTokens = (value, tokens) => {
        const normalized = normalize(value);
        if (!normalized) return false;
        return tokens.every((token) => normalized.includes(token));
      };
      const isKindMatch = (kind, combined, targetLabels) => {
        if (includesAny(combined, targetLabels)) return true;
        if (kind === 'share') return hasTokens(combined, ['share', 'export']) || hasTokens(combined, ['分享', '导出']);
        if (kind === 'export') return hasTokens(combined, ['export']) || hasTokens(combined, ['导出']);
        if (kind === 'export-docs') {
          return hasTokens(combined, ['export', 'docs'])
            || hasTokens(combined, ['导出', '文档'])
            || hasTokens(combined, ['导出', 'docs']);
        }
        if (kind === 'action-menu') {
          return hasTokens(combined, ['conversation', 'action']) || hasTokens(combined, ['会话', '操作']);
        }
        return false;
      };
      const triggerClick = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        try { node.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { node.focus({ preventScroll: true }); } catch {}
        try {
          const EventCtor = window.PointerEvent || window.MouseEvent;
          node.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, cancelable: true, composed: true, button: 0 }));
        } catch {}
        try { node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch {}
        try { node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, button: 0 })); } catch {}
        try { node.click(); } catch { return false; }
        return true;
      };

      const ensureRecorder = () => {
        if (!Array.isArray(window[recorderKey])) window[recorderKey] = [];
        const push = (prefix, raw) => {
          const url = String(raw || '').trim();
          if (!url) return;
          window[recorderKey].push(prefix + '::' + url);
        };
        const extractUrlsFromText = (rawText) => {
          const text = String(rawText || '');
          const urls = [];
          const direct = text.match(/https?:\\/\\/[^\\s"'<>\\\\]+/g) || [];
          urls.push(...direct);
          const escaped = text.match(/https?:\\\\\\/\\\\\\/[^\\s"'<>]+/g) || [];
          for (const item of escaped) {
            urls.push(
              item
                .split('\\\\/').join('/')
                .split('\\\\u003d').join('=')
                .split('\\\\u0026').join('&'),
            );
          }
          return Array.from(new Set(urls.map((value) => String(value || '').trim()).filter(Boolean)));
        };
        const extractDocsIdsFromText = (rawText) => {
          const text = String(rawText || '');
          const ids = [];
          const patterns = [
            /"id"\\s*:\\s*"([a-zA-Z0-9_-]{15,})"/g,
            /'id'\\s*:\\s*'([a-zA-Z0-9_-]{15,})'/g,
          ];
          for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
              const docId = String(match[1] || '').trim();
              if (docId) ids.push(docId);
            }
          }
          return Array.from(new Set(ids));
        };
        const docsUrlFromId = (id) => {
          const docId = String(id || '').trim();
          if (!/^[a-zA-Z0-9_-]{15,}$/.test(docId)) return '';
          return 'https://docs.google.com/document/d/' + docId + '/edit';
        };
        const isDriveDocCreateRequest = (url) => /\\/upload\\/drive\\/v3\\/files/i.test(String(url || ''));

        if (window[patchedKey]) return push;
        window[patchedKey] = true;

        const originalFetch = window.fetch.bind(window);
        window.fetch = (...args) => {
          let reqUrl = '';
          try {
            const input = args[0];
            reqUrl = typeof input === 'string' ? input : (input && input.url) || '';
            push('fetch', reqUrl);
          } catch {}
          return originalFetch(...args).then((response) => {
            try {
              response.clone().text().then((text) => {
                const embeddedUrls = extractUrlsFromText(text);
                for (const embeddedUrl of embeddedUrls) push('fetch-body', embeddedUrl);
                if (isDriveDocCreateRequest(reqUrl)) {
                  const docIds = extractDocsIdsFromText(text);
                  for (const docId of docIds) {
                    const docUrl = docsUrlFromId(docId);
                    if (docUrl) push('fetch-body-docs-id', docUrl);
                  }
                }
              }).catch(() => {});
            } catch {}
            return response;
          });
        };

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          try { push('xhr', url); } catch {}
          try { this.__opencliReqUrl = String(url || ''); } catch {}
          return originalXhrOpen.call(this, method, url, ...rest);
        };
        const originalXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(...args) {
          try {
            this.addEventListener('load', () => {
              try {
                const embeddedUrls = extractUrlsFromText(this.responseText || '');
                for (const embeddedUrl of embeddedUrls) push('xhr-body', embeddedUrl);
                const reqUrl = String(this.__opencliReqUrl || '');
                if (isDriveDocCreateRequest(reqUrl)) {
                  const docIds = extractDocsIdsFromText(this.responseText || '');
                  for (const docId of docIds) {
                    const docUrl = docsUrlFromId(docId);
                    if (docUrl) push('xhr-body-docs-id', docUrl);
                  }
                }
              } catch {}
            });
          } catch {}
          return originalXhrSend.apply(this, args);
        };

        const originalOpen = window.open.bind(window);
        window.open = (...args) => {
          try { push('open', args[0]); } catch {}
          return originalOpen(...args);
        };

        const originalAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(...args) {
          try { push('anchor', this.href || this.getAttribute('href')); } catch {}
          return originalAnchorClick.apply(this, args);
        };

        return push;
      };

      const pushUrl = ensureRecorder();
      const collectUrls = () => {
        try {
          const entries = performance.getEntriesByType('resource');
          for (const entry of entries) {
            if (!entry || !entry.name) continue;
            pushUrl('performance', entry.name);
          }
        } catch {}
        try {
          const anchors = queryAllDeep([document], 'a[href]');
          for (const anchor of anchors) {
            const href = anchor.getAttribute('href') || '';
            if (!href) continue;
            if (/docs\\.google\\.com\\/document\\//i.test(href)) pushUrl('anchor', href);
          }
        } catch {}
        const all = Array.isArray(window[recorderKey]) ? window[recorderKey] : [];
        return Array.from(new Set(all.map((value) => String(value || '').trim()).filter(Boolean)));
      };

      const clickByLabels = (kind, targetLabels, roots) => {
        const allRoots = Array.isArray(roots) && roots.length > 0 ? roots : [document];
        const selector = 'button, [role="button"], [role="menuitem"], [role="option"], a, li';

        for (const root of allRoots) {
          if (!(root instanceof Document || root instanceof Element)) continue;
          let nodes = [];
          try {
            nodes = Array.from(root.querySelectorAll(selector));
          } catch {
            continue;
          }

          for (const node of nodes) {
            if (!isInteractable(node)) continue;
            const combined = normalize(textOf(node));
            if (!combined) continue;
            if (!isKindMatch(kind, combined, targetLabels)) continue;
            if (triggerClick(node)) {
              const clickedText = (textOf(node) || targetLabels[0] || '').trim();
              tracePush('clicked', kind + '|' + clickedText.slice(0, 120));
              return clickedText;
            }
          }
        }
        tracePush('miss', kind);
        return '';
      };

      const getDialogRoots = () =>
        queryAllDeep([document], '[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')
          .filter((node) => isVisible(node));
      const buildRoots = () => {
        const dialogRoots = getDialogRoots();
        if (dialogRoots.length > 0) return [...dialogRoots, document];
        return [document];
      };
      const clickWithRetry = async (kind, targetLabels, attempts, delayMs, includeDialogs = true) => {
        for (let index = 0; index < attempts; index += 1) {
          const roots = includeDialogs ? buildRoots() : [document];
          const clicked = clickByLabels(kind, targetLabels, roots);
          if (clicked) return clicked;
          await sleep(delayMs);
        }
        return '';
      };

      tracePush('start', window.location.href);
      let exportDocsBtn = await clickWithRetry('export-docs', labelsNormalized.exportDocs, 2, 250, true);
      let share = '';
      if (!exportDocsBtn) {
        share = await clickWithRetry('share', labelsNormalized.share, 4, 280, true);
      }
      if (!exportDocsBtn && !share) {
        await clickWithRetry('action-menu', labelsNormalized.actionMenu, 2, 250, false);
        await clickWithRetry('share-conversation', labelsNormalized.shareConversation, 2, 250, true);
        share = await clickWithRetry('share', labelsNormalized.share, 4, 280, true);
      }
      if (!exportDocsBtn) {
        await sleep(350);
        exportDocsBtn = await clickWithRetry('export-docs', labelsNormalized.exportDocs, 8, 280, true);
      }
      if (!exportDocsBtn) {
        const exportEntry = await clickWithRetry('export', labelsNormalized.export, 2, 220, true);
        if (exportEntry) {
          await sleep(240);
          exportDocsBtn = await clickWithRetry('export-docs', labelsNormalized.exportDocs, 6, 280, true);
        }
      }

      if (!share && !exportDocsBtn) {
        return { ok: false, step: 'share', currentUrl: window.location.href, trace, urls: collectUrls() };
      }
      if (!exportDocsBtn) {
        return { ok: false, step: 'export-docs', currentUrl: window.location.href, share, trace, urls: collectUrls() };
      }

      const deadline = Date.now() + ${Math.max(5e3, Math.min(maxWaitMs, 18e4))};
      while (Date.now() < deadline) {
        const urls = collectUrls();
        const hasDocsSignal = urls.some((value) => /docs\\.google\\.com\\/document\\//i.test(String(value || '')));
        const sameTabDocs = /docs\\.google\\.com\\/document\\//i.test(window.location.href || '');
        if (hasDocsSignal) {
          return { ok: true, step: 'done', currentUrl: window.location.href, share, exportDocs: exportDocsBtn, trace, urls };
        }
        if (sameTabDocs) {
          urls.push('open::' + window.location.href);
          return { ok: true, step: 'same-tab-docs', currentUrl: window.location.href, share, exportDocs: exportDocsBtn, trace, urls };
        }
        await sleep(300);
      }

      return { ok: true, step: 'timeout', currentUrl: window.location.href, share, exportDocs: exportDocsBtn, trace, urls: collectUrls() };
    })()
  `;
}
function extractDocsUrlFromTabs(tabs) {
  if (!Array.isArray(tabs))
    return "";
  for (const tab of tabs) {
    if (!tab || typeof tab !== "object")
      continue;
    const url = String(tab.url ?? "").trim();
    if (/^https:\/\/docs\.google\.com\/document\//i.test(url))
      return url;
  }
  return "";
}
async function exportGeminiDeepResearchReport(page, timeoutSeconds = 120) {
  await ensureGeminiPage(page);
  const timeoutMs = Math.max(1, timeoutSeconds) * 1e3;
  const tabsBefore = await page.tabs().catch(() => []);
  const exportScript = exportGeminiDeepResearchReportScript(timeoutMs);
  const raw = await page.evaluate(exportScript).catch(() => null);
  const tabsAfter = await page.tabs().catch(() => []);
  const docsUrlFromTabs = extractDocsUrlFromTabs(tabsAfter) || extractDocsUrlFromTabs(tabsBefore);
  if (docsUrlFromTabs) {
    return { url: docsUrlFromTabs, source: "tab" };
  }
  const docsUrlFromCurrent = typeof raw?.currentUrl === "string" && /^https:\/\/docs\.google\.com\/document\//i.test(raw.currentUrl) ? raw.currentUrl : "";
  if (docsUrlFromCurrent) {
    return { url: docsUrlFromCurrent, source: "window-open" };
  }
  const urls = normalizeGeminiExportUrls(raw?.urls);
  const currentUrl = typeof raw?.currentUrl === "string" && raw.currentUrl ? raw.currentUrl : await getCurrentGeminiUrl(page);
  return pickGeminiDeepResearchExportUrl(urls, currentUrl);
}

// ../browser-agent/opencli/clis/gemini/deep-research-result.js
var DEEP_RESEARCH_WAITING_MESSAGE = "Deep Research is still running. Please wait and retry later.";
var DEEP_RESEARCH_NO_DOCS_MESSAGE = "No Docs URL found. Please check Share & Export -> Export to Docs in Gemini UI.";
var DEEP_RESEARCH_PENDING_MESSAGE = "Deep Research may still be running or preparing export. Please wait and retry later.";
function isDeepResearchInProgress(text) {
  return /\bresearching(?:\s+websites?)?\b|research in progress|working on your research|generating research plan|gathering sources|creating report|planning research|正在研究|研究中|调研中|生成研究计划|搜集资料|请稍候|稍候|请等待/i.test(text);
}
function isDeepResearchCompleted(text) {
  return /\bcompleted\b|research complete|completed research|report completed|已完成|研究完成|完成了研究|报告已完成/i.test(text);
}
async function resolveDeepResearchExportResponse(page, timeoutSeconds) {
  const exported = await exportGeminiDeepResearchReport(page, timeoutSeconds);
  if (exported.url)
    return exported.url;
  const snapshot = await readGeminiSnapshot(page).catch(() => null);
  if (snapshot?.isGenerating)
    return DEEP_RESEARCH_WAITING_MESSAGE;
  const latest = await getLatestGeminiAssistantResponse(page).catch(() => "");
  const turnTail = Array.isArray(snapshot?.turns) ? snapshot.turns.slice(-6).map((turn) => String(turn?.Text ?? "")).join("\n") : "";
  const transcriptTail = Array.isArray(snapshot?.transcriptLines) ? snapshot.transcriptLines.slice(-30).join("\n") : "";
  const statusText = [latest, turnTail, transcriptTail].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
  if (statusText && isDeepResearchInProgress(statusText) && !isDeepResearchCompleted(statusText)) {
    return DEEP_RESEARCH_WAITING_MESSAGE;
  }
  if (statusText && isDeepResearchCompleted(statusText)) {
    return DEEP_RESEARCH_NO_DOCS_MESSAGE;
  }
  return DEEP_RESEARCH_PENDING_MESSAGE;
}
var deepResearchResultCommand = cli({
  site: "gemini",
  name: "deep-research-result",
  access: "read",
  description: "Export Deep Research report URL from a Gemini conversation",
  domain: GEMINI_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  defaultFormat: "plain",
  args: [
    { name: "query", positional: true, required: false, help: "Conversation title or URL (optional; defaults to latest conversation)" },
    { name: "match", required: false, default: "contains", choices: ["contains", "exact"], help: "Match mode" },
    { name: "timeout", type: "int", required: false, default: 120, help: "Max seconds to wait for Docs export (default: 120)" }
  ],
  columns: ["response"],
  func: async (page, kwargs) => {
    const query = String(kwargs.query ?? "").trim();
    const matchMode = parseGeminiTitleMatchMode(kwargs.match);
    const timeoutSeconds = kwargs.timeout;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
      throw new ArgumentError("--timeout must be a positive integer (seconds)");
    }
    if (!matchMode) {
      return [{ response: "Invalid match mode. Use contains or exact." }];
    }
    const state = await getGeminiPageState(page);
    if (state.isSignedIn === false) {
      return [{ response: "Not signed in to Gemini." }];
    }
    const conversationUrl = parseGeminiConversationUrl(query);
    if (conversationUrl) {
      await page.goto(conversationUrl, { waitUntil: "load", settleMs: 2500 });
      await page.wait(1);
      await waitForGeminiTranscript(page);
      return [{ response: await resolveDeepResearchExportResponse(page, timeoutSeconds) }];
    }
    const conversations = await getGeminiConversationList(page);
    const picked = resolveGeminiConversationForQuery(conversations, query, matchMode);
    if (picked?.Url) {
      await page.goto(picked.Url, { waitUntil: "load", settleMs: 2500 });
      await page.wait(1);
      await waitForGeminiTranscript(page);
    } else if (query) {
      if (matchMode === "exact") {
        return [{ response: `No conversation matched: ${query}` }];
      }
      const clicked = await clickGeminiConversationByTitle(page, query);
      if (!clicked) {
        return [{ response: `No conversation matched: ${query}` }];
      }
      await waitForGeminiTranscript(page);
    }
    return [{ response: await resolveDeepResearchExportResponse(page, timeoutSeconds) }];
  }
});
export {
  deepResearchResultCommand
};
