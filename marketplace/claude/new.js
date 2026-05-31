// ../browser-agent/opencli/clis/claude/new.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/claude/utils.js
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
var CLAUDE_DOMAIN = "claude.ai";
var CLAUDE_URL = "https://claude.ai/new";
var COMPOSER_SELECTOR = '[data-testid="chat-input"]';
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
async function ensureClaudeComposer(page, message = "Claude composer is not available on the current page.") {
  const state = await ensureClaudeLogin(page, message);
  if (!state.hasComposer) {
    throw new CommandExecutionError(message);
  }
  return state;
}

// ../browser-agent/opencli/clis/claude/new.js
var newCommand = cli({
  site: "claude",
  name: "new",
  access: "read",
  description: "Start a new conversation in Claude",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Status"],
  func: async (page) => {
    await page.goto(CLAUDE_URL);
    try {
      await page.wait({ selector: COMPOSER_SELECTOR, timeout: 8 });
    } catch {
    }
    await ensureClaudeComposer(page, "Claude new requires a logged-in Claude session with a visible composer.");
    return [{ Status: "New chat started" }];
  }
});
export {
  newCommand
};
