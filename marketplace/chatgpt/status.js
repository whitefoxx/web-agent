// ../browser-agent/opencli/clis/chatgpt/status.js
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

// ../browser-agent/opencli/clis/chatgpt/status.js
var statusCommand = cli({
  site: "chatgpt",
  name: "status",
  access: "read",
  description: "Check ChatGPT web page availability and login state",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Status", "Login", "Url"],
  func: async (page) => {
    await ensureOnChatGPT(page);
    const state = await getPageState(page);
    return [{
      Status: state.hasComposer ? "Connected" : "Page not ready",
      Login: state.isLoggedIn && !state.hasLoginGate ? "Yes" : "No",
      Url: state.url
    }];
  }
});
export {
  statusCommand
};
