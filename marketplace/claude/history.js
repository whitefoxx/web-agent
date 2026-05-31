// ../browser-agent/opencli/clis/claude/history.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/claude/utils.js

var CLAUDE_DOMAIN = "claude.ai";
var COMPOSER_SELECTOR = '[data-testid="chat-input"]';
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
function requirePositiveInt(value, flagLabel, hint) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArgumentError(`${flagLabel} must be a positive integer`, hint);
  }
  return value;
}
async function getConversationList(page) {
  if (!await isOnClaude(page) || !(await page.evaluate("window.location.href") || "").includes("/recents")) {
    await page.goto("https://claude.ai/recents");
    try {
      await page.wait({ selector: 'a[href*="/chat/"]', timeout: 8 });
    } catch {
    }
  }
  const items = await page.evaluate(`(() => {
        var links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
        return links.map(function(link, i) {
            var href = link.getAttribute('href') || '';
            var idMatch = href.match(/\\/chat\\/([a-f0-9-]+)/);
            return {
                Index: i + 1,
                Id: idMatch ? idMatch[1] : href,
                Title: (link.innerText || '').trim().split('\\n')[0].trim() || '(untitled)',
                Url: href.startsWith('http') ? href : ('https://claude.ai' + href),
            };
        });
    })()`);
  return Array.isArray(items) ? items : [];
}

// ../browser-agent/opencli/clis/claude/history.js
var historyCommand = cli({
  site: "claude",
  name: "history",
  access: "read",
  description: "List conversation history from Claude /recents",
  domain: CLAUDE_DOMAIN,
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
      "claude history --limit",
      "Example: opencli claude history --limit 20"
    );
    const conversations = await getConversationList(page);
    await ensureClaudeLogin(page, "Claude history requires a logged-in Claude session.");
    if (conversations.length === 0) {
      throw new EmptyResultError("claude history", "No Claude conversation history was visible on /recents.");
    }
    return conversations.slice(0, limit);
  }
});
export {
  historyCommand
};
