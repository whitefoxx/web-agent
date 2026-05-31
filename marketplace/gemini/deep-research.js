// ../browser-agent/opencli/clis/gemini/deep-research.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/gemini/utils.js

var GEMINI_DOMAIN = "gemini.google.com";
var GEMINI_APP_URL = "https://gemini.google.com/app";
var GEMINI_DEEP_RESEARCH_DEFAULT_TOOL_LABELS = ["Deep Research", "Deep research", "深度研究"];
var GEMINI_DEEP_RESEARCH_DEFAULT_CONFIRM_LABELS = [
  "Start research",
  "Start Research",
  "Start deep research",
  "Start Deep Research",
  "Generate research plan",
  "Generate Research Plan",
  "Generate deep research plan",
  "Generate Deep Research Plan",
  "开始研究",
  "开始深度研究",
  "开始调研",
  "生成研究计划",
  "生成调研计划"
];
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
var GEMINI_COMPOSER_PREPARE_ATTEMPTS = 4;
var GEMINI_COMPOSER_PREPARE_WAIT_SECONDS = 1;
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
function resolveGeminiLabels(value, fallback) {
  const label = String(value ?? "").trim();
  return label ? [label] : fallback;
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
function hasGeminiTurnPrefix(before, current) {
  if (before.length > current.length)
    return false;
  return before.every((turn, index) => turn.Role === current[index]?.Role && turn.Text === current[index]?.Text);
}
function diffTrustedStructuredTurns(before, current) {
  if (!before.structuredTurnsTrusted || !current.structuredTurnsTrusted) {
    return {
      appendedTurns: [],
      hasTrustedAppend: false,
      hasNewUserTurn: false,
      hasNewAssistantTurn: false
    };
  }
  if (!hasGeminiTurnPrefix(before.turns, current.turns)) {
    return {
      appendedTurns: [],
      hasTrustedAppend: false,
      hasNewUserTurn: false,
      hasNewAssistantTurn: false
    };
  }
  const appendedTurns = current.turns.slice(before.turns.length);
  return {
    appendedTurns,
    hasTrustedAppend: appendedTurns.length > 0,
    hasNewUserTurn: appendedTurns.some((turn) => turn.Role === "User"),
    hasNewAssistantTurn: appendedTurns.some((turn) => turn.Role === "Assistant")
  };
}
function diffTranscriptLines(before, current) {
  const beforeLines = new Set(before.transcriptLines);
  return current.transcriptLines.filter((line) => !beforeLines.has(line));
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
function isGeminiConversationUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== GEMINI_DOMAIN && !parsed.hostname.endsWith(`.${GEMINI_DOMAIN}`))
      return false;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname.startsWith("/app/") && pathname !== "/app";
  } catch {
    return false;
  }
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
function prepareComposerScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();

      if (!(composer instanceof HTMLElement)) {
        return { ok: false, reason: 'Could not find Gemini composer' };
      }

      try {
        composer.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        composer.textContent = '';
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      return {
        ok: true,
        label: composer.getAttribute('aria-label') || '',
      };
    })()
  `;
}
function composerHasTextScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();

      return {
        hasText: !!(composer && ((composer.textContent || '').trim() || (composer.innerText || '').trim())),
      };
    })()
  `;
}
function insertComposerTextFallbackScript(text) {
  return `
    ((inputText) => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();

      if (!(composer instanceof HTMLElement)) {
        return { hasText: false, reason: 'Could not find Gemini composer' };
      }

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);

      composer.focus();
      composer.textContent = '';
      const execResult = typeof document.execCommand === 'function'
        ? document.execCommand('insertText', false, inputText)
        : false;

      if (!execResult) {
        const paragraph = document.createElement('p');
        const lines = String(inputText).split(/\\n/);
        for (const [index, line] of lines.entries()) {
          if (index > 0) paragraph.appendChild(document.createElement('br'));
          paragraph.appendChild(document.createTextNode(line));
        }
        composer.replaceChildren(paragraph);
      }

      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: inputText, inputType: 'insertText' }));
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: inputText, inputType: 'insertText' }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));

      return {
        hasText: !!((composer.textContent || '').trim() || (composer.innerText || '').trim()),
      };
    })(${JSON.stringify(text)})
  `;
}
function submitComposerScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();

      if (!(composer instanceof HTMLElement)) {
        throw new Error('Could not find Gemini composer');
      }

      const composerRect = composer.getBoundingClientRect();
      const rootCandidates = [
        composer.closest('form'),
        composer.closest('[role="form"]'),
        composer.closest('.input-area-container'),
        composer.closest('.textbox-container'),
        composer.closest('.input-wrapper'),
        composer.parentElement,
        composer.parentElement?.parentElement,
      ].filter(Boolean);

      const seen = new Set();
      const buttons = [];
      for (const root of rootCandidates) {
        root.querySelectorAll('button, [role="button"]').forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (seen.has(node)) return;
          seen.add(node);
          buttons.push(node);
        });
      }

      const excludedPattern = /main menu|主菜单|microphone|麦克风|upload|上传|mode|模式|tools|工具|settings|临时对话|new chat|新对话/i;
      const submitPattern = /send|发送|submit|提交/i;
      let bestButton = null;
      let bestScore = -1;

      for (const button of buttons) {
        if (!isVisible(button)) continue;
        if (button instanceof HTMLButtonElement && button.disabled) continue;
        if (button.getAttribute('aria-disabled') === 'true') continue;

        const label = ((button.getAttribute('aria-label') || '') + ' ' + ((button.textContent || '').trim())).trim();
        if (excludedPattern.test(label)) continue;

        const rect = button.getBoundingClientRect();
        const verticalDistance = Math.abs((rect.top + rect.bottom) / 2 - (composerRect.top + composerRect.bottom) / 2);
        if (verticalDistance > 160) continue;

        let score = 0;
        if (submitPattern.test(label)) score += 10;
        if (rect.left >= composerRect.right - 160) score += 3;
        if (rect.left >= composerRect.left) score += 1;
        if (rect.width <= 96 && rect.height <= 96) score += 1;

        if (score > bestScore) {
          bestScore = score;
          bestButton = button;
        }
      }

      if (bestButton instanceof HTMLElement && bestScore >= 3) {
        bestButton.click();
        return 'button';
      }

      return 'enter';
    })()
  `;
}
function dispatchComposerEnterScript() {
  return `
    (() => {
      ${buildGeminiComposerLocatorScript()}
      const composer = findComposer();

      if (!(composer instanceof HTMLElement)) {
        throw new Error('Could not find Gemini composer');
      }

      composer.focus();
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'enter';
    })()
  `;
}
function clickNewChatScript() {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(document.querySelectorAll('button, a')).filter((node) => {
        const text = (node.textContent || '').trim().toLowerCase();
        const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
        return isVisible(node) && (
          text === 'new chat'
          || aria === 'new chat'
          || text === '发起新对话'
          || aria === '发起新对话'
          || text === '新对话'
          || aria === '新对话'
        );
      });

      const target = candidates.find((node) => !node.hasAttribute('disabled')) || candidates[0];
      if (target instanceof HTMLElement) {
        target.click();
        return 'clicked';
      }
      return 'navigate';
    })()
  `;
}
function openGeminiToolsMenuScript() {
  return `
    (() => {
      const labels = ['tools', 'tool', 'mode', '研究', 'deep research', 'deep-research', '工具'];
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const matchesLabel = (value) => {
        const text = normalize(value);
        return labels.some((label) => text.includes(label));
      };

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

      const isInteractable = (el) => isVisible(el) && !isDisabled(el);

      const roots = [
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('header'),
        document,
      ].filter(Boolean);

      const isMenuTrigger = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const popupValue = (node.getAttribute('aria-haspopup') || '').toLowerCase();
        const hasPopup = popupValue === 'menu' || popupValue === 'listbox' || popupValue === 'true';
        const controls = (node.getAttribute('aria-controls') || '').toLowerCase();
        const hasControls = ['menu', 'listbox', 'popup'].some((token) => controls.includes(token));
        return hasPopup || hasControls;
      };

      const menuAlreadyOpen = () => {
        const visibleMenus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).filter(isVisible);
        const labeledMenu = visibleMenus.some((menu) => {
          const text = menu.textContent || '';
          const aria = menu.getAttribute('aria-label') || '';
          return matchesLabel(text) || matchesLabel(aria);
        });
        if (labeledMenu) return true;
        const expanded = Array.from(document.querySelectorAll('[aria-expanded="true"]')).filter(isVisible);
        return expanded.some((node) => {
          if (!(node instanceof HTMLElement)) return false;
          const text = node.textContent || '';
          const aria = node.getAttribute('aria-label') || '';
          return isMenuTrigger(node) && (matchesLabel(text) || matchesLabel(aria));
        });
      };

      if (menuAlreadyOpen()) return true;

      const pickTarget = (root) => {
        const nodes = Array.from(root.querySelectorAll('button, [role="button"]')).filter(isInteractable);
        const matches = nodes.filter((node) => {
          const text = (node.textContent || '').trim().toLowerCase();
          const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (!text && !aria) return false;
          return matchesLabel(text) || matchesLabel(aria);
        });
        if (matches.length === 0) return null;
        const menuMatches = matches.filter((node) => isMenuTrigger(node));
        return menuMatches[0] || matches[0];
      };

      let target = null;
      for (const root of roots) {
        target = pickTarget(root);
        if (target) break;
      }
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    })()
  `;
}
function selectGeminiToolScript(labels) {
  const labelsJson = JSON.stringify(labels);
  return `
    ((targetLabels) => {
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

      const isInteractable = (el) => isVisible(el) && !isDisabled(el);

      const normalized = Array.isArray(targetLabels)
        ? targetLabels.map((label) => String(label || '').trim()).filter((label) => label)
        : [];
      const lowered = normalized.map((label) => label.toLowerCase());
      if (lowered.length === 0) return '';

      const menuSelectors = [
        '[role="menu"]',
        '[role="listbox"]',
        '[aria-label*="tool" i]',
        '[aria-label*="mode" i]',
        '[aria-modal="true"]',
      ];
      const menuRoots = Array.from(document.querySelectorAll(menuSelectors.join(','))).filter(isVisible);
      if (menuRoots.length === 0) return '';
      const seen = new Set();

      for (const root of menuRoots) {
        const candidates = Array.from(root.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], a, li'));
        for (const node of candidates) {
          if (seen.has(node)) continue;
          seen.add(node);
          if (!isInteractable(node)) continue;
          const text = (node.textContent || '').trim().toLowerCase();
          const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
          if (!text && !aria) continue;
          const combined = \`\${text} \${aria}\`.trim();
          for (let index = 0; index < lowered.length; index += 1) {
            const label = lowered[index];
            if (label && combined.includes(label)) {
              if (node instanceof HTMLElement) node.click();
              return normalized[index];
            }
          }
        }
      }

      return '';
    })(${labelsJson})
  `;
}
function clickGeminiConfirmButtonScript(labels) {
  const labelsJson = JSON.stringify(labels);
  return `
    ((targetLabels) => {
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

      const isInteractable = (el) => isVisible(el) && !isDisabled(el);

      const normalized = Array.isArray(targetLabels)
        ? targetLabels.map((label) => String(label || '').trim()).filter((label) => label)
        : [];
      const lowered = normalized.map((label) => label.toLowerCase());
      if (lowered.length === 0) return '';

      const dialogRoots = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(isVisible);
      const mainRoot = document.querySelector('main');
      const primaryRoots = [...dialogRoots, mainRoot].filter(Boolean).filter(isVisible);
      const rootGroups = primaryRoots.length > 0 ? [primaryRoots, [document]] : [[document]];
      const seen = new Set();

      for (const roots of rootGroups) {
        for (const root of roots) {
          const candidates = Array.from(root.querySelectorAll('button, [role="button"]'));
          for (const node of candidates) {
            if (seen.has(node)) continue;
            seen.add(node);
            if (!isInteractable(node)) continue;
            const text = (node.textContent || '').trim().toLowerCase();
            const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
            if (!text && !aria) continue;
            const combined = \`\${text} \${aria}\`.trim();
            for (let index = 0; index < lowered.length; index += 1) {
              const label = lowered[index];
              if (label && combined.includes(label)) {
                if (node instanceof HTMLElement) node.click();
                return normalized[index];
              }
            }
          }
        }
      }

      return '';
    })(${labelsJson})
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
async function openGeminiToolsMenu(page) {
  await ensureGeminiPage(page);
  const opened = await page.evaluate(openGeminiToolsMenuScript());
  if (opened) {
    await page.wait(0.5);
    return true;
  }
  return false;
}
async function selectGeminiTool(page, labels) {
  await ensureGeminiPage(page);
  await openGeminiToolsMenu(page);
  const matched = await page.evaluate(selectGeminiToolScript(labels));
  return typeof matched === "string" ? matched : "";
}
async function waitForGeminiConfirmButton(page, labels, timeoutSeconds) {
  await ensureGeminiPage(page);
  const pollIntervalSeconds = 1;
  const maxPolls = Math.max(1, Math.ceil(timeoutSeconds / pollIntervalSeconds));
  for (let index = 0; index < maxPolls; index += 1) {
    await page.wait(index === 0 ? 0.5 : pollIntervalSeconds);
    const matched = await page.evaluate(clickGeminiConfirmButtonScript(labels));
    if (typeof matched === "string" && matched)
      return matched;
  }
  return "";
}
async function startNewGeminiChat(page) {
  await ensureGeminiPage(page);
  const action = await page.evaluate(clickNewChatScript());
  if (action === "navigate") {
    await page.goto(GEMINI_APP_URL, { waitUntil: "load", settleMs: 2500 });
  }
  await page.wait(1);
  return action;
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
function findLastUserTurnIndex(turns) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.Role === "User")
      return index;
  }
  return null;
}
function findLastUserTurn(turns) {
  const index = findLastUserTurnIndex(turns);
  return index === null ? null : turns[index] ?? null;
}
async function waitForGeminiSubmission(page, before, timeoutSeconds) {
  const preSendAssistantCount = before.turns.filter((turn) => turn.Role === "Assistant").length;
  const maxPolls = Math.max(1, Math.ceil(timeoutSeconds));
  for (let index = 0; index < maxPolls; index += 1) {
    await page.wait(index === 0 ? 0.5 : 1);
    const current = await readGeminiSnapshot(page);
    const structuredAppend = diffTrustedStructuredTurns(before, current);
    const transcriptDelta = diffTranscriptLines(before, current);
    if (structuredAppend.hasTrustedAppend && structuredAppend.hasNewUserTurn) {
      return {
        snapshot: current,
        preSendAssistantCount,
        userAnchorTurn: findLastUserTurn(current.turns),
        reason: "user_turn"
      };
    }
    if (!current.composerHasText && current.isGenerating) {
      return {
        snapshot: current,
        preSendAssistantCount,
        userAnchorTurn: findLastUserTurn(current.turns),
        reason: "composer_generating"
      };
    }
    const transcriptSubmissionAllowed = !current.url || isGeminiConversationUrl(String(current.url));
    if (!current.composerHasText && transcriptDelta.length > 0 && transcriptSubmissionAllowed) {
      return {
        snapshot: current,
        preSendAssistantCount,
        userAnchorTurn: findLastUserTurn(current.turns),
        reason: "composer_transcript"
      };
    }
  }
  return null;
}
async function sendGeminiMessage(page, text) {
  await ensureGeminiPage(page);
  let prepared;
  for (let attempt = 0; attempt < GEMINI_COMPOSER_PREPARE_ATTEMPTS; attempt += 1) {
    prepared = await page.evaluate(prepareComposerScript());
    if (prepared?.ok)
      break;
    if (attempt < GEMINI_COMPOSER_PREPARE_ATTEMPTS - 1)
      await page.wait(GEMINI_COMPOSER_PREPARE_WAIT_SECONDS);
  }
  if (!prepared?.ok) {
    throw new CommandExecutionError(prepared?.reason || "Could not find Gemini composer");
  }
  let hasText = false;
  if (page.nativeType) {
    try {
      await page.nativeType(text);
      await page.wait(0.2);
      const nativeState = await page.evaluate(composerHasTextScript());
      hasText = !!nativeState?.hasText;
    } catch {
    }
  }
  if (!hasText) {
    const fallbackState = await page.evaluate(insertComposerTextFallbackScript(text));
    hasText = !!fallbackState?.hasText;
  }
  if (!hasText) {
    throw new CommandExecutionError("Failed to insert text into Gemini composer");
  }
  const submitAction = await page.evaluate(submitComposerScript());
  if (submitAction === "button") {
    await page.wait(1);
    return "button";
  }
  if (page.nativeKeyPress) {
    try {
      await page.nativeKeyPress("Enter");
    } catch {
      await page.evaluate(dispatchComposerEnterScript());
    }
  } else {
    await page.evaluate(dispatchComposerEnterScript());
  }
  await page.wait(1);
  return "enter";
}

// ../browser-agent/opencli/clis/gemini/deep-research.js
function isGeminiRootAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname.replace(/\/+$/, "") === GEMINI_APP_URL;
  } catch {
    return false;
  }
}
function parseDeepResearchProgress(text) {
  const isResearching = /\bresearching(?:\s+websites?)?\b|research in progress|working on your research|正在研究|研究中/i.test(text);
  const waitingForStart = /\bstart(?:\s+deep)?\s+research\b|begin\s+research|generate(?:\s+deep)?\s+research\s+plan|开始研究|开始深度研究|开始调研|生成研究计划|生成调研计划|try again without deep research/i.test(text);
  return { isResearching, waitingForStart };
}
var deepResearchCommand = cli({
  site: "gemini",
  name: "deep-research",
  access: "write",
  description: "Start a Gemini Deep Research run and confirm it",
  domain: GEMINI_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  defaultFormat: "plain",
  args: [
    { name: "prompt", positional: true, required: true, help: "Prompt to send" },
    { name: "timeout", type: "int", required: false, help: "Max seconds for the overall command (default: 180; confirm-wait clamps internally to 6-20s)", default: 180 },
    { name: "tool", required: false, help: "Override tool label (default: Deep Research)" },
    { name: "confirm", required: false, help: "Override confirm button label (default: Start research)" }
  ],
  columns: ["status", "url"],
  func: async (page, kwargs) => {
    const prompt = kwargs.prompt;
    const timeout = kwargs.timeout;
    if (!Number.isInteger(timeout) || timeout < 1) {
      throw new ArgumentError("--timeout must be a positive integer (seconds)");
    }
    const submitTimeout = Math.min(Math.max(timeout, 6), 20);
    await startNewGeminiChat(page);
    const toolLabels = resolveGeminiLabels(kwargs.tool, GEMINI_DEEP_RESEARCH_DEFAULT_TOOL_LABELS);
    const confirmLabels = resolveGeminiLabels(kwargs.confirm, GEMINI_DEEP_RESEARCH_DEFAULT_CONFIRM_LABELS);
    const toolMatched = await selectGeminiTool(page, toolLabels);
    if (!toolMatched) {
      const url2 = await getCurrentGeminiUrl(page);
      return [{ status: "tool-not-found", url: url2 }];
    }
    let baseline = await readGeminiSnapshot(page);
    await sendGeminiMessage(page, prompt);
    let submitted = await waitForGeminiSubmission(page, baseline, submitTimeout);
    if (!submitted) {
      await selectGeminiTool(page, toolLabels);
      baseline = await readGeminiSnapshot(page);
      await sendGeminiMessage(page, prompt);
      submitted = await waitForGeminiSubmission(page, baseline, submitTimeout);
    }
    if (!submitted) {
      const url2 = await getCurrentGeminiUrl(page);
      return [{ status: "submit-not-found", url: url2 }];
    }
    const confirmed = await waitForGeminiConfirmButton(page, confirmLabels, timeout);
    let url = await getCurrentGeminiUrl(page);
    if (confirmed && !isGeminiRootAppUrl(url)) {
      return [{ status: "started", url }];
    }
    {
      if (isGeminiRootAppUrl(url)) {
        await selectGeminiTool(page, toolLabels);
        const confirmedRetry = await waitForGeminiConfirmButton(page, confirmLabels, timeout);
        url = await getCurrentGeminiUrl(page);
        if (confirmedRetry && !isGeminiRootAppUrl(url)) {
          return [{ status: "started", url }];
        }
      }
      let response = await getLatestGeminiAssistantResponse(page);
      let { isResearching, waitingForStart } = parseDeepResearchProgress(response);
      if (!isResearching && waitingForStart) {
        const fallbackConfirmLabels = Array.from(/* @__PURE__ */ new Set([
          ...confirmLabels,
          ...GEMINI_DEEP_RESEARCH_DEFAULT_CONFIRM_LABELS
        ]));
        const confirmedFallback = await waitForGeminiConfirmButton(page, fallbackConfirmLabels, Math.min(timeout, 8));
        if (confirmedFallback) {
          url = await getCurrentGeminiUrl(page);
          response = await getLatestGeminiAssistantResponse(page);
          ({ isResearching, waitingForStart } = parseDeepResearchProgress(response));
        }
      }
      if (isResearching && !waitingForStart) {
        return [{ status: "started", url }];
      }
      return [{ status: "confirm-not-found", url }];
    }
  }
});
export {
  deepResearchCommand
};
