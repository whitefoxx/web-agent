// ../browser-agent/opencli/clis/claude/detail.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/claude/utils.js

var CLAUDE_DOMAIN = "claude.ai";
var COMPOSER_SELECTOR = '[data-testid="chat-input"]';
var MESSAGE_SELECTOR = ".font-claude-response";
async function getPageState(page) {
  return page.evaluate(`(() => {
        var composer = document.querySelector('${COMPOSER_SELECTOR}');
        var userMenu = document.querySelector('[data-testid="user-menu-button"]');
        return {
            url: window.location.href,
            title: document.title,
            hasComposer: !!composer,
            isLoggedIn: !!userMenu,
        };
    })()`);
}
async function ensureClaudeLogin(page, message = "Claude requires a logged-in browser session.") {
  const state = await getPageState(page);
  if (!state.isLoggedIn) {
    throw new AuthRequiredError(CLAUDE_DOMAIN, message);
  }
  return state;
}
function requireConversationId(value) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new ArgumentError(
      "claude detail requires a conversation id",
      "Example: opencli claude detail 123e4567-e89b-12d3-a456-426614174000"
    );
  }
  return id;
}
async function getVisibleMessages(page) {
  const result = await page.evaluate(`(() => {
        var nodes = document.querySelectorAll('[data-testid="user-message"], ${MESSAGE_SELECTOR}');
        var rows = [];
        Array.from(nodes).forEach(function(el) {
            var isUser = el.getAttribute('data-testid') === 'user-message';
            var raw = (el.innerText || '').trim();
            if (!isUser) {
                var parts = raw.split(/\\n\\n+/);
                while (parts.length > 1 && /^(Thought|View)\\b/i.test(parts[0])) parts.shift();
                raw = parts.join('\\n\\n').trim();
            }
            if (raw) rows.push({ role: isUser ? 'user' : 'assistant', text: raw });
        });
        return rows;
    })()`);
  if (!Array.isArray(result)) return [];
  return result.map(function(r, i) {
    return { Index: i, Role: r.role, Text: r.text };
  });
}

// ../browser-agent/opencli/clis/claude/detail.js
var detailCommand = cli({
  site: "claude",
  name: "detail",
  access: "read",
  description: "Open a Claude conversation by ID and read its messages",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "id", positional: true, required: true, help: "Conversation ID (UUID from /chat/<id>)" }
  ],
  columns: ["Index", "Role", "Text"],
  func: async (page, kwargs) => {
    const id = requireConversationId(kwargs.id);
    await page.goto(`https://claude.ai/chat/${id}`);
    try {
      await page.wait({ selector: MESSAGE_SELECTOR, timeout: 10 });
    } catch {
    }
    await ensureClaudeLogin(page, "Claude detail requires a logged-in Claude session.");
    const messages = await getVisibleMessages(page);
    if (messages.length > 0) return messages;
    throw new EmptyResultError("claude detail", `No visible Claude messages were found for conversation ${id}.`);
  }
});
export {
  detailCommand
};
