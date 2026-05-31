// ../browser-agent/opencli/clis/claude/read.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/claude/utils.js

var CLAUDE_DOMAIN = "claude.ai";
var CLAUDE_URL = "https://claude.ai/new";
var COMPOSER_SELECTOR = '[data-testid="chat-input"]';
var MESSAGE_SELECTOR = ".font-claude-response";
async function isOnClaude(page) {
  const url = await page.evaluate("window.location.href").catch(() => "");
  if (typeof url !== "string" || !url) return false;
  try {
    const h = new URL(url).hostname;
    return h === CLAUDE_DOMAIN || h.endsWith(`.${CLAUDE_DOMAIN}`);
  } catch {
    return false;
  }
}
async function ensureOnClaude(page) {
  if (await isOnClaude(page)) return false;
  await page.goto(CLAUDE_URL);
  try {
    await page.wait({ selector: COMPOSER_SELECTOR, timeout: 8 });
  } catch {
  }
  return true;
}
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

// ../browser-agent/opencli/clis/claude/read.js
var readCommand = cli({
  site: "claude",
  name: "read",
  access: "read",
  description: "Read the current Claude conversation",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Index", "Role", "Text"],
  func: async (page) => {
    await ensureOnClaude(page);
    await ensureClaudeLogin(page, "Claude read requires a logged-in Claude session.");
    const messages = await getVisibleMessages(page);
    if (messages.length > 0) return messages;
    throw new EmptyResultError("claude read", "No visible Claude messages were found in the current conversation.");
  }
});
export {
  readCommand
};
