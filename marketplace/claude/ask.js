// ../browser-agent/opencli/clis/claude/ask.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/claude/utils.js

var CLAUDE_DOMAIN = "claude.ai";
var CLAUDE_URL = "https://claude.ai/new";
var COMPOSER_SELECTOR = '[data-testid="chat-input"]';
var MESSAGE_SELECTOR = ".font-claude-response";
var MODEL_DROPDOWN_SELECTOR = '[data-testid="model-selector-dropdown"]';
var MODEL_DISPLAY_NAMES = {
  sonnet: "Sonnet 4.6",
  opus: "Opus 4.7",
  haiku: "Haiku 4.5"
};
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
function requirePositiveInt(value, flagLabel, hint) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ArgumentError(`${flagLabel} must be a positive integer`, hint);
  }
  return value;
}
async function selectModel(page, modelName) {
  const display = MODEL_DISPLAY_NAMES[String(modelName).toLowerCase()];
  if (!display) return { ok: false };
  const opened = await page.evaluate(`(() => {
        var trigger = document.querySelector('${MODEL_DROPDOWN_SELECTOR}');
        if (!trigger) return { ok: false };
        var label = trigger.getAttribute('aria-label') || '';
        if (label.indexOf(${JSON.stringify(display)}) >= 0) {
            return { ok: true, toggled: false };
        }
        trigger.click();
        return { ok: true, opened: true };
    })()`);
  if (!opened?.ok) return opened;
  if (!opened.opened) return opened;
  try {
    await page.wait({ selector: 'div[role="menuitemradio"]', timeout: 3 });
  } catch {
  }
  return page.evaluate(`(() => {
        var items = Array.from(document.querySelectorAll('div[role="menuitemradio"]'));
        var target = items.find(function(el) { return (el.innerText || '').indexOf(${JSON.stringify(display)}) >= 0; });
        if (!target) return { ok: false };
        // Free-tier locked options carry an inline "Upgrade" button next to the label.
        var upgrade = target.querySelector('button');
        if (upgrade && (upgrade.innerText || '').toLowerCase().indexOf('upgrade') >= 0) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { ok: false, upgrade: true };
        }
        var alreadySelected = target.getAttribute('aria-checked') === 'true';
        if (!alreadySelected) target.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: true, toggled: !alreadySelected };
    })()`);
}
async function setAdaptiveThinking(page, enabled) {
  const opened = await page.evaluate(`(() => {
        var trigger = document.querySelector('${MODEL_DROPDOWN_SELECTOR}');
        if (!trigger) return { ok: false };
        trigger.click();
        return { ok: true };
    })()`);
  if (!opened?.ok) return { ok: false };
  try {
    await page.wait({ selector: 'div[role="menuitem"]', timeout: 3 });
  } catch {
  }
  return page.evaluate(`(() => {
        var items = Array.from(document.querySelectorAll('div[role="menuitem"]'));
        var target = items.find(function(el) { return (el.innerText || '').indexOf('Adaptive thinking') >= 0; });
        if (!target) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return { ok: false };
        }
        var isActive = target.getAttribute('aria-checked') === 'true';
        if (${enabled} !== isActive) target.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: true, toggled: ${enabled} !== isActive };
    })()`);
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
async function getBubbleCount(page) {
  const count = await page.evaluate(`(() => {
        return document.querySelectorAll('${MESSAGE_SELECTOR}').length;
    })()`);
  return count || 0;
}
async function waitForResponse(page, baselineCount, prompt, timeoutMs) {
  const startTime = Date.now();
  let lastText = "";
  let stableCount = 0;
  while (Date.now() - startTime < timeoutMs) {
    await page.wait(3);
    let result;
    try {
      result = await page.evaluate(`(() => {
                var bubbles = document.querySelectorAll('${MESSAGE_SELECTOR}');
                // Adaptive thinking renders "Thought process" labels at the top
                // of the response (often duplicated for the expand/collapse widget).
                // Strip them so the row value is the actual answer text.
                var texts = Array.from(bubbles).map(function(b) {
                    var raw = (b.innerText || '').trim();
                    // Drop leading paragraphs that are widget labels:
                    //   "Thought process" / "Thought for Xs" — Adaptive thinking expand widget
                    //   "View uploaded image" / "View attachment" — file thumbnail label
                    // These render twice (collapsed + expanded) and are followed by a blank line.
                    var parts = raw.split(/\\n\\n+/);
                    while (parts.length > 1 && /^(Thought|View)\\b/i.test(parts[0])) parts.shift();
                    return parts.join('\\n\\n').trim();
                }).filter(Boolean);
                return {
                    count: texts.length,
                    last: texts[texts.length - 1] || '',
                    streaming: !!document.querySelector('[data-is-streaming="true"]'),
                };
            })()`);
    } catch {
      continue;
    }
    if (!result) continue;
    const candidate = result.last;
    if (!candidate || candidate === prompt.trim()) continue;
    if (result.count <= baselineCount) continue;
    if (result.streaming) {
      lastText = candidate;
      stableCount = 0;
      continue;
    }
    if (candidate === lastText) {
      stableCount++;
      if (stableCount >= 3) return candidate;
    } else {
      stableCount = 0;
      lastText = candidate;
    }
  }
  return lastText || null;
}
async function waitForFilePreview(page, fileName) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.wait(1);
    const ready = await page.evaluate(`(() => {
            // Claude renders attachments as data-testid="file-thumbnail" cards with
            // a sibling Remove button. Either signal indicates the file took.
            if (document.querySelector('[data-testid="file-thumbnail"]')) return true;
            var removeBtn = Array.from(document.querySelectorAll('button'))
                .find(function(b) { return (b.getAttribute('aria-label') || '') === 'Remove'; });
            return !!removeBtn;
        })()`);
    if (ready) return true;
  }
  return false;
}
async function sendWithFile(page, filePath, prompt) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const absPath = path.default.resolve(filePath);
  if (!fs.default.existsSync(absPath)) {
    return { ok: false, reason: `File not found: ${absPath}` };
  }
  const stats = fs.default.statSync(absPath);
  if (stats.size > 30 * 1024 * 1024) {
    return { ok: false, reason: `File too large (${(stats.size / 1024 / 1024).toFixed(1)} MB). Max: 30 MB` };
  }
  const fileName = path.default.basename(absPath);
  let uploaded = false;
  if (page.setFileInput) {
    try {
      await page.setFileInput([absPath], 'input[data-testid="file-upload"]');
      const fired = await page.evaluate(`(() => {
                var inp = document.querySelector('input[data-testid="file-upload"]');
                if (!inp) return { ok: false, reason: 'file input not found' };
                var propsKey = Object.keys(inp).find(function(k) { return k.startsWith('__reactProps$'); });
                if (propsKey && typeof inp[propsKey].onChange === 'function') {
                    inp[propsKey].onChange({ target: { files: inp.files } });
                    return { ok: true, via: 'react' };
                }
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, via: 'native' };
            })()`);
      if (!fired?.ok) return fired;
      uploaded = true;
    } catch (err) {
      const msg = String(err?.message || err);
      if (!msg.includes("Unknown action") && !msg.includes("not supported") && !msg.includes("Not allowed")) {
        throw err;
      }
    }
  }
  if (!uploaded) {
    const content = fs.default.readFileSync(absPath);
    const base64 = content.toString("base64");
    const fallbackResult = await page.evaluate(`(async () => {
            var binary = atob('${base64}');
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            var file = new File([bytes], ${JSON.stringify(fileName)});
            var dt = new DataTransfer();
            dt.items.add(file);

            var inp = document.querySelector('input[data-testid="file-upload"]');
            if (!inp) return { ok: false, reason: 'file input not found' };

            var propsKey = Object.keys(inp).find(function(k) { return k.startsWith('__reactProps$'); });
            if (!propsKey || typeof inp[propsKey].onChange !== 'function') {
                return { ok: false, reason: 'React onChange not found' };
            }

            inp.files = dt.files;
            inp[propsKey].onChange({ target: { files: inp.files } });
            return { ok: true };
        })()`);
    if (fallbackResult && !fallbackResult.ok) return fallbackResult;
  }
  const ready = await waitForFilePreview(page, fileName);
  if (!ready) return { ok: false, reason: "file preview did not appear" };
  return sendMessage(page, prompt);
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

// ../browser-agent/opencli/clis/claude/ask.js
var askCommand = cli({
  site: "claude",
  name: "ask",
  access: "write",
  description: "Send a prompt to Claude and get the response",
  domain: CLAUDE_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: "persistent",
  navigateBefore: false,
  args: [
    { name: "prompt", positional: true, required: true, help: "Prompt to send" },
    { name: "timeout", type: "int", default: 120, help: "Max seconds to wait for response" },
    { name: "new", type: "boolean", default: false, help: "Start a new chat before sending" },
    { name: "model", default: "sonnet", choices: ["sonnet", "opus", "haiku"], help: "Model to use: sonnet, opus, or haiku" },
    { name: "think", type: "boolean", default: false, help: "Enable Adaptive thinking" },
    { name: "file", help: "Attach a file (image, PDF, text) with the prompt" }
  ],
  columns: ["response"],
  func: async (page, kwargs) => {
    const prompt = requireNonEmptyPrompt(kwargs.prompt, "claude ask");
    const timeoutSeconds = requirePositiveInt(
      Number(kwargs.timeout ?? 120),
      "claude ask --timeout",
      'Example: opencli claude ask "hello" --timeout 120'
    );
    const timeoutMs = timeoutSeconds * 1e3;
    const wantThink = parseBoolFlag(kwargs.think);
    if (parseBoolFlag(kwargs.new)) {
      await page.goto(CLAUDE_URL);
      try {
        await page.wait({ selector: COMPOSER_SELECTOR, timeout: 8 });
      } catch {
      }
    } else {
      const navigated = await ensureOnClaude(page);
      if (navigated) {
        await page.evaluate(`(() => {
                    var link = document.querySelector('a[href*="/chat/"]');
                    if (link) link.click();
                })()`);
        try {
          await page.wait({ selector: MESSAGE_SELECTOR, timeout: 5 });
        } catch {
        }
      }
    }
    await withRetry(() => ensureClaudeComposer(page, "Claude ask requires a visible composer on the current page."));
    const currentUrl = await page.evaluate("window.location.href") || "";
    const inConversation = currentUrl.includes("/chat/");
    const modelExplicit = kwargs.__opencliOptionSources?.model === "cli";
    const wantModel = kwargs.model || "sonnet";
    if (inConversation && modelExplicit) {
      throw new ArgumentError(
        `Cannot switch to ${wantModel} model inside an existing conversation.`,
        "Re-run with --new to start a fresh chat before selecting a model."
      );
    }
    if (!inConversation) {
      const modelResult = await withRetry(() => selectModel(page, wantModel));
      if (!modelResult?.ok) {
        if (modelResult?.upgrade) {
          throw new ArgumentError(
            `${wantModel} model requires a paid Claude plan.`,
            "Pick --model sonnet or --model haiku, or upgrade your account."
          );
        }
        throw new CommandExecutionError(`Could not switch to ${wantModel} model`);
      }
    }
    const thinkResult = await withRetry(() => setAdaptiveThinking(page, wantThink));
    if (!thinkResult?.ok && wantThink) {
      throw new CommandExecutionError("Could not enable Adaptive thinking");
    }
    if (kwargs.file) {
      const baseline2 = await withRetry(() => getBubbleCount(page));
      try {
        const fileResult = await sendWithFile(page, kwargs.file, prompt);
        if (fileResult && !fileResult.ok) {
          throw new CommandExecutionError(fileResult.reason || "Failed to attach file");
        }
      } catch (err) {
        if (!String(err?.message || err).includes("Promise was collected")) throw err;
      }
      const result2 = await waitForResponse(page, baseline2, prompt, timeoutMs);
      if (!result2) {
        throw new EmptyResultError(
          "claude ask",
          `No Claude response appeared within ${timeoutSeconds}s. Re-run with a higher --timeout if the model is still generating.`
        );
      }
      return [{ response: result2 }];
    }
    const baseline = await withRetry(() => getBubbleCount(page));
    const sendResult = await withRetry(() => sendMessage(page, prompt));
    if (!sendResult?.ok) {
      throw new CommandExecutionError(sendResult?.reason || "Failed to send message");
    }
    const result = await waitForResponse(page, baseline, prompt, timeoutMs);
    if (!result) {
      throw new EmptyResultError(
        "claude ask",
        `No Claude response appeared within ${timeoutSeconds}s. Re-run with a higher --timeout if the model is still generating.`
      );
    }
    return [{ response: result }];
  }
});
export {
  askCommand
};
