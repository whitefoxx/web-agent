// ../browser-agent/opencli/clis/chatgpt/ask.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/chatgpt/utils.js
import { htmlToMarkdown } from "@jackwener/opencli/utils";

var CHATGPT_DOMAIN = "chatgpt.com";
var CHATGPT_URL = "https://chatgpt.com";
var COMPOSER_SELECTORS = [
  '[aria-label="Chat with ChatGPT"]',
  '[aria-label="与 ChatGPT 聊天"]',
  '[placeholder="Ask anything"]',
  '[placeholder="有问题，尽管问"]',
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][role="textbox"]'
];
var SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"]:not([disabled])';
var SEND_BUTTON_FALLBACK_SELECTORS = [
  "#composer-submit-button:not([disabled])"
];
var SEND_BUTTON_LABELS = [
  "Send prompt",
  "Send message",
  "Send",
  "发送提示"
];
var CLOSE_SIDEBAR_LABELS = [
  "Close sidebar",
  "关闭边栏"
];
function buildComposerLocatorScript() {
  const markerAttr = "data-opencli-chatgpt-composer";
  return `
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const markerAttr = ${JSON.stringify(markerAttr)};
      const clearMarkers = (active) => {
        document.querySelectorAll('[' + markerAttr + ']').forEach(node => {
          if (node !== active) node.removeAttribute(markerAttr);
        });
      };

      const findComposer = () => {
        const marked = document.querySelector('[' + markerAttr + '="1"]');
        if (marked instanceof HTMLElement && isVisible(marked)) return marked;

        for (const selector of ${JSON.stringify(COMPOSER_SELECTORS)}) {
          const node = Array.from(document.querySelectorAll(selector)).find(c => c instanceof HTMLElement && isVisible(c));
          if (node instanceof HTMLElement) {
            node.setAttribute(markerAttr, '1');
            return node;
          }
        }
        return null;
      };

      findComposer.toString = () => 'findComposer';
    `;
}
function normalizeBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}
function requireNonEmptyPrompt(prompt, commandName) {
  const text = String(prompt ?? "").trim();
  if (!text) {
    throw new ArgumentError(
      `${commandName} prompt cannot be empty`,
      `Example: opencli ${commandName} "hello"`
    );
  }
  return text;
}
function requirePositiveInt(value, flagLabel, hint) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArgumentError(`${flagLabel} must be a positive integer`, hint);
  }
  return value;
}
function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
function requireArrayEvaluateResult(payload, label) {
  if (!Array.isArray(payload)) {
    if (payload && typeof payload === "object" && "error" in payload) {
      throw new CommandExecutionError(`${label}: ${String(payload.error)}`);
    }
    throw new CommandExecutionError(`${label} returned malformed extraction payload`);
  }
  return payload;
}
function requireObjectEvaluateResult(payload, label) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new CommandExecutionError(`${label} returned malformed extraction payload`);
  }
  return payload;
}
function requireBooleanEvaluateResult(payload, label) {
  if (typeof payload !== "boolean") {
    throw new CommandExecutionError(`${label} returned malformed extraction payload`);
  }
  return payload;
}
async function currentChatGPTUrl(page) {
  const url = unwrapEvaluateResult(await page.evaluate("window.location.href").catch(() => ""));
  return typeof url === "string" ? url : "";
}
async function isOnChatGPT(page) {
  const url = await currentChatGPTUrl(page);
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === CHATGPT_DOMAIN || host.endsWith(`.${CHATGPT_DOMAIN}`);
  } catch {
    return false;
  }
}
var COMPOSER_WAIT_SELECTOR = '#prompt-textarea, [data-testid="prompt-textarea"]';
async function ensureOnChatGPT(page) {
  if (await isOnChatGPT(page)) return false;
  await page.goto(CHATGPT_URL, { settleMs: 2e3 });
  try {
    await page.wait({ selector: COMPOSER_WAIT_SELECTOR, timeout: 8 });
  } catch {
  }
  return true;
}
async function startNewChat(page) {
  await page.goto(`${CHATGPT_URL}/new`, { settleMs: 2e3 });
  try {
    await page.wait({ selector: COMPOSER_WAIT_SELECTOR, timeout: 8 });
  } catch {
  }
}
async function getPageState(page) {
  return requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`(() => {
        const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const composerSelectors = ${JSON.stringify(COMPOSER_SELECTORS)};
        const hasComposer = composerSelectors.some((selector) =>
            Array.from(document.querySelectorAll(selector)).some((node) => isVisible(node))
        );
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
        const loginLink = Array.from(document.querySelectorAll('a, button')).find((node) => {
            const label = ((node.innerText || node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '')).trim().toLowerCase();
            return isVisible(node) && /^(log in|login|sign up|sign in)$/.test(label);
        });
        const userMenu = document.querySelector('[data-testid="profile-button"], [aria-label*="Profile"], [aria-label*="Account"], button[id*="headlessui-menu-button"]');
        const hasLoginGate = !!loginLink || /log in to chatgpt|sign up to chatgpt|welcome to chatgpt/i.test(text);
        return {
            url: window.location.href,
            title: document.title,
            hasComposer,
            isLoggedIn: hasComposer || !!userMenu || !hasLoginGate,
            hasLoginGate,
        };
    })()`)), "chatgpt page state");
}
async function ensureChatGPTLogin(page, message = "ChatGPT requires a logged-in browser session.") {
  const state = await getPageState(page);
  if (!state.isLoggedIn || state.hasLoginGate) {
    throw new AuthRequiredError(CHATGPT_DOMAIN, message);
  }
  return state;
}
async function ensureChatGPTComposer(page, message = "ChatGPT composer is not available on the current page.") {
  const state = await ensureChatGPTLogin(page, message);
  if (!state.hasComposer) {
    throw new CommandExecutionError(message);
  }
  return state;
}
async function sendChatGPTMessage(page, text) {
  await page.evaluate(`
        (() => {
            const labels = ${JSON.stringify(CLOSE_SIDEBAR_LABELS)};
            const closeBtn = Array.from(document.querySelectorAll('button')).find(b => labels.includes(b.getAttribute('aria-label') || ''));
            if (closeBtn) closeBtn.click();
        })()
    `);
  const typeResult = requireBooleanEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
        (() => {
            ${buildComposerLocatorScript()}
            const composer = findComposer();
            if (!composer) return false;
            composer.focus();
            if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
                composer.value = '';
            } else if (composer.isContentEditable) {
                composer.textContent = '';
                composer.innerHTML = '<p><br></p>';
            } else {
                composer.textContent = '';
            }
            composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
            composer.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()
    `)), "chatgpt composer readiness");
  if (!typeResult) return false;
  try {
    if (page.nativeType) {
      await page.nativeType(text);
    } else {
      throw new Error("nativeType unavailable");
    }
  } catch (e) {
    await page.evaluate(`
            (() => {
                var composer = null;
                var sels = ${JSON.stringify(COMPOSER_SELECTORS)};
                for (var si = 0; si < sels.length; si++) { composer = document.querySelector(sels[si]); if (composer) break; }
                if (!composer) return;
                composer.focus();
                document.execCommand('insertText', false, ${JSON.stringify(text)});
            })()
        `);
  }
  let sent = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.wait(0.5);
    sent = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
            (() => {
                const isUsable = (button) => button
                    && !button.disabled
                    && button.getAttribute('aria-disabled') !== 'true';
                const primary = document.querySelector(${JSON.stringify(SEND_BUTTON_SELECTOR)})
                    || ${JSON.stringify(SEND_BUTTON_FALLBACK_SELECTORS)}.map(selector => document.querySelector(selector)).find(Boolean);
                const btns = Array.from(document.querySelectorAll('button'));
                const labels = ${JSON.stringify(SEND_BUTTON_LABELS)};
                const sendBtn = isUsable(primary)
                    ? primary
                    : btns.find(b => labels.includes(b.getAttribute('aria-label') || '') && isUsable(b));
                return { sendBtnFound: !!sendBtn };
            })()
        `)), "chatgpt send button readiness");
    if (sent?.sendBtnFound) break;
  }
  if (!sent?.sendBtnFound) {
    return false;
  }
  await page.evaluate(`
        (() => {
            const primary = document.querySelector(${JSON.stringify(SEND_BUTTON_SELECTOR)})
                || ${JSON.stringify(SEND_BUTTON_FALLBACK_SELECTORS)}.map(selector => document.querySelector(selector)).find(Boolean);
            const labels = ${JSON.stringify(SEND_BUTTON_LABELS)};
            const sendBtn = primary || Array.from(document.querySelectorAll('button')).find(b => labels.includes(b.getAttribute('aria-label') || '') && !b.disabled);
            if (sendBtn) sendBtn.click();
        })()
    `);
  return true;
}
async function getVisibleMessages(page) {
  const result = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`(() => {
        const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const normalize = (value) => String(value || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
        const roleOf = (node) => {
            const attr = node.getAttribute('data-message-author-role') || node.getAttribute('data-author') || '';
            if (/assistant/i.test(attr)) return 'Assistant';
            if (/user/i.test(attr)) return 'User';
            const testid = node.getAttribute('data-testid') || '';
            if (/assistant/i.test(testid)) return 'Assistant';
            if (/user/i.test(testid)) return 'User';
            const label = node.getAttribute('aria-label') || '';
            if (/assistant|chatgpt/i.test(label)) return 'Assistant';
            if (/you|user/i.test(label)) return 'User';
            return '';
        };

        let nodes = Array.from(document.querySelectorAll('[data-message-author-role], article[data-testid*="conversation-turn"]'));
        nodes = nodes.filter((node) => node instanceof HTMLElement && isVisible(node));

        const rows = [];
        const seen = new Set();
        for (const node of nodes) {
            let role = roleOf(node);
            const roleNode = node.querySelector('[data-message-author-role], [data-author]');
            if (!role && roleNode) role = roleOf(roleNode);
            if (!role) continue;

            const contentNode = node.querySelector('[data-message-author-role] .markdown')
                || node.querySelector('.markdown')
                || node.querySelector('[data-message-author-role]')
                || node;
            const html = contentNode instanceof HTMLElement ? (contentNode.innerHTML || '') : '';
            const text = normalize(contentNode instanceof HTMLElement ? (contentNode.innerText || contentNode.textContent || '') : '');
            if (!text) continue;
            const key = role + '\\n' + text;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ role, text, html });
        }
        return rows;
    })()`)), "chatgpt visible messages");
  return result.map((item, index) => ({
    Index: index + 1,
    Role: item?.role === "Assistant" ? "Assistant" : "User",
    Text: String(item?.text || "").trim(),
    Html: String(item?.html || "")
  })).filter((item) => item.Text);
}
async function getBubbleCount(page) {
  const messages = await getVisibleMessages(page);
  return messages.length;
}
async function waitForChatGPTResponse(page, baselineCount, prompt, timeoutSeconds) {
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;
  while (Date.now() - startTime < timeoutSeconds * 1e3) {
    await page.wait(3);
    if (await isGenerating(page)) {
      stableCount = 0;
      continue;
    }
    const messages = await getVisibleMessages(page);
    const newMessages = messages.slice(Math.max(0, baselineCount));
    const assistant = [...newMessages].reverse().find((m) => m.Role === "Assistant") || [...messages].reverse().find((m) => m.Role === "Assistant");
    const candidate = String(assistant?.Text || "").trim();
    if (!candidate || candidate === String(prompt || "").trim()) continue;
    if (candidate === lastText) {
      stableCount += 1;
      if (stableCount >= 2) return candidate;
    } else {
      lastText = candidate;
      stableCount = 0;
    }
  }
  throw new TimeoutError(
    "chatgpt ask",
    timeoutSeconds,
    "No ChatGPT response appeared before timeout. Re-run with a higher --timeout if it is still generating."
  );
}
async function isGenerating(page) {
  return requireBooleanEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
        (() => {
            return Array.from(document.querySelectorAll('button')).some(b => {
                const label = b.getAttribute('aria-label') || '';
                return label === 'Stop generating' || label.includes('Thinking');
            });
        })()
    `)), "chatgpt generation state");
}

// ../browser-agent/opencli/clis/chatgpt/ask.js
var askCommand = cli({
  site: "chatgpt",
  name: "ask",
  access: "write",
  description: "Send a prompt to ChatGPT web and wait for the response",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "prompt", positional: true, required: true, help: "Prompt to send" },
    { name: "timeout", type: "int", default: 120, help: "Max seconds to wait for response" },
    { name: "new", type: "boolean", default: false, help: "Start a new chat before sending" }
  ],
  columns: ["response"],
  func: async (page, kwargs) => {
    const prompt = requireNonEmptyPrompt(kwargs.prompt, "chatgpt ask");
    const timeout = requirePositiveInt(
      Number(kwargs.timeout ?? 120),
      "chatgpt ask --timeout",
      'Example: opencli chatgpt ask "hello" --timeout 120'
    );
    if (normalizeBooleanFlag(kwargs.new)) {
      await startNewChat(page);
    } else {
      await ensureOnChatGPT(page);
    }
    await ensureChatGPTComposer(page, "ChatGPT ask requires a logged-in ChatGPT session with a visible composer.");
    const baseline = await getBubbleCount(page);
    const sent = await sendChatGPTMessage(page, prompt);
    if (!sent) {
      throw new CommandExecutionError("Failed to send message to ChatGPT", `Open ${CHATGPT_URL} and verify the composer is ready.`);
    }
    return [{ response: await waitForChatGPTResponse(page, baseline, prompt, timeout) }];
  }
});
export {
  askCommand
};
