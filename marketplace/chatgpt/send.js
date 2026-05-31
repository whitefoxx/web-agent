// ../browser-agent/opencli/clis/chatgpt/send.js
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
function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
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

// ../browser-agent/opencli/clis/chatgpt/send.js
var sendCommand = cli({
  site: "chatgpt",
  name: "send",
  access: "write",
  description: "Send a prompt to ChatGPT web without waiting for the response",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "prompt", positional: true, required: true, help: "Prompt to send" },
    { name: "new", type: "boolean", default: false, help: "Start a new chat before sending" }
  ],
  columns: ["Status", "InjectedText"],
  func: async (page, kwargs) => {
    const prompt = requireNonEmptyPrompt(kwargs.prompt, "chatgpt send");
    if (normalizeBooleanFlag(kwargs.new)) {
      await startNewChat(page);
    } else {
      await ensureOnChatGPT(page);
    }
    await ensureChatGPTComposer(page, "ChatGPT send requires a logged-in ChatGPT session with a visible composer.");
    const sent = await sendChatGPTMessage(page, prompt);
    if (!sent) {
      throw new CommandExecutionError("Failed to send message to ChatGPT", `Open ${CHATGPT_URL} and verify the composer is ready.`);
    }
    return [{ Status: "Success", InjectedText: prompt }];
  }
});
export {
  sendCommand
};
