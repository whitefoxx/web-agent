// ../browser-agent/opencli/clis/chatgpt/new.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/chatgpt/utils.js
import { htmlToMarkdown } from "@jackwener/opencli/utils";
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from "@jackwener/opencli/errors";
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
var COMPOSER_WAIT_SELECTOR = '#prompt-textarea, [data-testid="prompt-textarea"]';
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

// ../browser-agent/opencli/clis/chatgpt/new.js
var newCommand = cli({
  site: "chatgpt",
  name: "new",
  access: "read",
  description: "Start a new ChatGPT web conversation",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Status"],
  func: async (page) => {
    await startNewChat(page);
    await ensureChatGPTComposer(page, "ChatGPT new requires a logged-in ChatGPT session with a visible composer.");
    return [{ Status: "New chat started" }];
  }
});
export {
  newCommand
};
