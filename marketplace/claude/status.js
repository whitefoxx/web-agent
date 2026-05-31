// ../browser-agent/opencli/clis/claude/status.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/claude/utils.js
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
var CLAUDE_DOMAIN = "claude.ai";
var CLAUDE_URL = "https://claude.ai/new";
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

// ../browser-agent/opencli/clis/claude/status.js
var statusCommand = cli({
  site: "claude",
  name: "status",
  access: "read",
  description: "Check Claude page availability and login state",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Status", "Login", "Url"],
  func: async (page) => {
    await ensureOnClaude(page);
    const state = await getPageState(page);
    return [{
      Status: state.hasComposer ? "Connected" : "Page not ready",
      Login: state.isLoggedIn ? "Yes" : "No",
      Url: state.url
    }];
  }
});
export {
  statusCommand
};
