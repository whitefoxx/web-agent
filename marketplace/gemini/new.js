// ../browser-agent/opencli/clis/gemini/new.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/gemini/utils.js
import { CommandExecutionError } from "@jackwener/opencli/errors";
var GEMINI_DOMAIN = "gemini.google.com";
var GEMINI_APP_URL = "https://gemini.google.com/app";
function clickNewChatScript() {
  return `
    (() => {
      const isVisible = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(document.querySelectorAll('button, a')).filter((node) => {
        const text = (node.textContent || '').trim().toLowerCase();
        const aria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
        return isVisible(node) && (
          text === 'new chat'
          || aria === 'new chat'
          || text === '发起新对话'
          || aria === '发起新对话'
          || text === '新对话'
          || aria === '新对话'
        );
      });

      const target = candidates.find((node) => !node.hasAttribute('disabled')) || candidates[0];
      if (target instanceof HTMLElement) {
        target.click();
        return 'clicked';
      }
      return 'navigate';
    })()
  `;
}
function currentUrlScript() {
  return "window.location.href";
}
async function isOnGemini(page) {
  const url = await page.evaluate(currentUrlScript()).catch(() => "");
  if (typeof url !== "string" || !url)
    return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === GEMINI_DOMAIN || hostname.endsWith(`.${GEMINI_DOMAIN}`);
  } catch {
    return false;
  }
}
async function ensureGeminiPage(page) {
  if (!await isOnGemini(page)) {
    await page.goto(GEMINI_APP_URL, { waitUntil: "load", settleMs: 2500 });
    await page.wait(1);
  }
}
async function startNewGeminiChat(page) {
  await ensureGeminiPage(page);
  const action = await page.evaluate(clickNewChatScript());
  if (action === "navigate") {
    await page.goto(GEMINI_APP_URL, { waitUntil: "load", settleMs: 2500 });
  }
  await page.wait(1);
  return action;
}

// ../browser-agent/opencli/clis/gemini/new.js
var newCommand = cli({
  site: "gemini",
  name: "new",
  access: "read",
  description: "Start a new conversation in Gemini web chat",
  domain: GEMINI_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [],
  columns: ["Status", "Action"],
  func: async (page) => {
    const action = await startNewGeminiChat(page);
    return [{
      Status: "Success",
      Action: action === "navigate" ? "Reloaded /app as fallback" : "Clicked New chat"
    }];
  }
});
export {
  newCommand
};
