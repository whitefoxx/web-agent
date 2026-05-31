// ../browser-agent/opencli/clis/chatgpt/detail.js
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
function normalizeBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
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
function parseChatGPTConversationId(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:^|\/c\/)([A-Za-z0-9_-]{8,})(?:[/?#]|$)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return raw;
  throw new ArgumentError(
    "chatgpt detail requires a conversation id or /c/<id> URL",
    "Example: opencli chatgpt detail 123e4567-e89b-12d3-a456-426614174000"
  );
}
var CONVERSATION_MESSAGE_SELECTOR = '[data-message-author-role], article[data-testid*="conversation-turn"]';
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
function messageHtmlToMarkdown(html) {
  try {
    return htmlToMarkdown(html).trim();
  } catch {
    return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

// ../browser-agent/opencli/clis/chatgpt/detail.js
var detailCommand = cli({
  site: "chatgpt",
  name: "detail",
  access: "read",
  description: "Open a ChatGPT web conversation by ID and read its messages",
  domain: CHATGPT_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "id", positional: true, required: true, help: "Conversation ID or full /c/<id> URL" },
    { name: "markdown", type: "boolean", default: false, help: "Emit assistant replies as markdown" }
  ],
  columns: ["Index", "Role", "Text"],
  func: async (page, kwargs) => {
    const id = parseChatGPTConversationId(kwargs.id);
    const wantMarkdown = normalizeBooleanFlag(kwargs.markdown, false);
    await page.goto(`${CHATGPT_URL}/c/${id}`, { settleMs: 2e3 });
    try {
      await page.wait({ selector: CONVERSATION_MESSAGE_SELECTOR, timeout: 10 });
    } catch {
    }
    await ensureChatGPTLogin(page, "ChatGPT detail requires a logged-in ChatGPT session.");
    const messages = await getVisibleMessages(page);
    if (!messages.length) {
      throw new EmptyResultError("chatgpt detail", `No visible ChatGPT messages were found for conversation ${id}.`);
    }
    return messages.map((message) => ({
      Index: message.Index,
      Role: message.Role,
      Text: wantMarkdown && message.Role === "Assistant" && message.Html ? messageHtmlToMarkdown(message.Html) || message.Text : message.Text
    }));
  }
});
export {
  detailCommand
};
