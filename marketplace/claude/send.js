// ../browser-agent/opencli/clis/claude/send.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/claude/utils.js

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
function requireNonEmptyPrompt(prompt, commandName) {
  const text = String(prompt ?? "").trim();
  if (!text) {
    throw new ArgumentError(
      `${commandName} prompt cannot be empty`,
      `Example: opencli ${commandName} "hello"`
    );
  }
  return text;
}
async function sendMessage(page, prompt) {
  const promptJson = JSON.stringify(prompt);
  const composerReady = await page.evaluate(`(() => {
        var box = document.querySelector('${COMPOSER_SELECTOR}');
        if (!box) return false;
        box.focus();
        // ProseMirror editors hold content in nested <p>; clear via Range/delete
        // rather than .value or textContent, which the editor won't notice.
        var sel = window.getSelection();
        sel.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(box);
        sel.addRange(range);
        document.execCommand('delete', false);
        return true;
    })()`);
  if (!composerReady) return { ok: false, reason: "composer not found" };
  let typedNatively = false;
  if (page.nativeType) {
    try {
      await page.nativeType(prompt);
      typedNatively = true;
    } catch (err) {
      const msg = String(err?.message || err);
      if (!msg.includes("Unknown action") && !msg.includes("not supported")) throw err;
    }
  }
  if (!typedNatively) {
    await page.evaluate(`(() => {
            var box = document.querySelector('${COMPOSER_SELECTOR}');
            if (!box) return;
            box.focus();
            document.execCommand('insertText', false, ${promptJson});
        })()`);
  }
  await page.wait(1.2);
  return page.evaluate(`(() => {
        var ariaCandidates = [
            'button[aria-label="Send Message"]',
            'button[aria-label="Send message"]',
            'button[aria-label="Send"]',
            'button[aria-label*="Send"]',
        ];
        for (var i = 0; i < ariaCandidates.length; i++) {
            var btn = document.querySelector(ariaCandidates[i]);
            if (btn && !btn.disabled) { btn.click(); return { ok: true }; }
        }
        // Fallback: rightmost enabled button with an svg in the composer container.
        var box = document.querySelector('${COMPOSER_SELECTOR}');
        if (box) {
            var c = box.parentElement;
            for (var hop = 0; hop < 6 && c; hop++) {
                var btns = Array.from(c.querySelectorAll('button')).filter(function(b) { return !b.disabled && b.querySelector('svg'); });
                if (btns.length) { btns[btns.length - 1].click(); return { ok: true, method: 'fallback' }; }
                c = c.parentElement;
            }
        }
        var box2 = document.querySelector('${COMPOSER_SELECTOR}');
        if (box2) {
            box2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            return { ok: true, method: 'enter' };
        }
        return { ok: false, reason: 'send button not found' };
    })()`);
}
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || err);
      if (i < retries && msg.includes("Promise was collected")) {
        await new Promise((r) => setTimeout(r, 2e3));
        continue;
      }
      throw err;
    }
  }
}
function parseBoolFlag(value) {
  if (typeof value === "boolean") return value;
  return String(value ?? "").trim().toLowerCase() === "true";
}

// ../browser-agent/opencli/clis/claude/send.js
var sendCommand = cli({
  site: "claude",
  name: "send",
  access: "write",
  description: "Send a prompt to Claude without waiting for the response",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "prompt", positional: true, required: true, help: "Prompt to send" },
    { name: "new", type: "boolean", default: false, help: "Start a new chat before sending" }
  ],
  columns: ["Status", "SubmittedBy", "InjectedText"],
  func: async (page, kwargs) => {
    const prompt = requireNonEmptyPrompt(kwargs.prompt, "claude send");
    if (parseBoolFlag(kwargs.new)) {
      await page.goto(CLAUDE_URL);
      try {
        await page.wait({ selector: COMPOSER_SELECTOR, timeout: 8 });
      } catch {
      }
    } else {
      await ensureOnClaude(page);
    }
    await withRetry(() => ensureClaudeComposer(page, "Claude send requires a visible composer on the current page."));
    const sendResult = await withRetry(() => sendMessage(page, prompt));
    if (!sendResult?.ok) {
      throw new CommandExecutionError(sendResult?.reason || "Failed to send message");
    }
    return [{
      Status: "Success",
      SubmittedBy: sendResult.method || "send-button",
      InjectedText: prompt
    }];
  }
});
export {
  sendCommand
};
