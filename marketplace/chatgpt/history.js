// ../browser-agent/opencli/clis/chatgpt/history.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError, TimeoutError } from "@jackwener/opencli/errors";
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
var CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';
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
async function ensureChatGPTLogin(page, message = "ChatGPT requires a logged-in browser session.") {
  const state = await getPageState(page);
  if (!state.isLoggedIn || state.hasLoginGate) {
    throw new AuthRequiredError(CHATGPT_DOMAIN, message);
  }
  return state;
}
async function getConversationList(page) {
  await ensureOnChatGPT(page);
  const openSidebar = requireBooleanEvaluateResult(unwrapEvaluateResult(await page.evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('button'))
            .find((node) => /open sidebar/i.test(node.getAttribute('aria-label') || ''));
        if (button instanceof HTMLElement) {
            button.click();
            return true;
        }
        return false;
    })()`)), "chatgpt sidebar open state");
  if (openSidebar) {
    try {
      await page.wait({ selector: CONVERSATION_LINK_SELECTOR, timeout: 3 });
    } catch {
    }
  }
  let items = await extractConversationLinks(page);
  if (!items.length) {
    await page.goto(CHATGPT_URL, { settleMs: 2e3 });
    try {
      await page.wait({ selector: CONVERSATION_LINK_SELECTOR, timeout: 8 });
    } catch {
    }
    items = await extractConversationLinks(page);
  }
  return items;
}
async function extractConversationLinks(page) {
  const items = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`(() => {
        const isVisible = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const links = Array.from(document.querySelectorAll('a[href*="/c/"]'))
            .filter((link) => link instanceof HTMLAnchorElement && isVisible(link));
        const seen = new Set();
        const rows = [];
        for (const link of links) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\\/c\\/([^/?#]+)/);
            if (!match || seen.has(match[1])) continue;
            seen.add(match[1]);
            const title = (link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim() || '(untitled)';
            rows.push({
                Id: match[1],
                Title: title,
                Url: href.startsWith('http') ? href : ('${CHATGPT_URL}' + href),
            });
        }
        return rows;
    })()`)), "chatgpt conversation link extraction");
  return items.map((item, index) => ({
    Index: index + 1,
    Id: String(item?.Id || ""),
    Title: String(item?.Title || "(untitled)").trim() || "(untitled)",
    Url: String(item?.Url || "")
  })).filter((item) => item.Id);
}

// ../browser-agent/opencli/clis/chatgpt/history.js
var historyCommand = cli({
  site: "chatgpt",
  name: "history",
  access: "read",
  description: "List visible ChatGPT web conversation history from the sidebar",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "limit", type: "int", default: 20, help: "Max conversations to show" }
  ],
  columns: ["Index", "Id", "Title", "Url"],
  func: async (page, kwargs) => {
    const limit = requirePositiveInt(
      Number(kwargs.limit ?? 20),
      "chatgpt history --limit",
      "Example: opencli chatgpt history --limit 20"
    );
    await ensureOnChatGPT(page);
    await ensureChatGPTLogin(page, "ChatGPT history requires a logged-in ChatGPT session.");
    const conversations = await getConversationList(page);
    if (!conversations.length) {
      throw new EmptyResultError("chatgpt history", "No ChatGPT conversation links were visible in the sidebar.");
    }
    return conversations.slice(0, limit);
  }
});
export {
  historyCommand
};
