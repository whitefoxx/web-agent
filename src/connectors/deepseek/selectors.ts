/**
 * DOM selectors / fingerprints for chat.deepseek.com.
 *
 * DeepSeek uses CSS-modules with content-hashed class names like `_27c9245`,
 * which change across deploys. We avoid those and rely on stable signals:
 *
 *   - HTML attributes: textarea[name], aria-disabled, data-virtual-list-item-key
 *   - SVG path fingerprints for icon-only buttons
 *   - Stable text labels: "New chat"
 *   - DeepSeek-namespaced classes that look semantic: ds-message, ds-markdown,
 *     ds-assistant-message-main-content, ds-think-content. These are owned by
 *     DeepSeek's design-system and rotate less often than build hashes.
 */

export const TEXTAREA = 'textarea[name="search"]';
export const TEXTAREA_FALLBACK = 'textarea[placeholder*="Message DeepSeek" i]';

export const MESSAGE_LIST = '.ds-virtual-list-visible-items';
export const MESSAGE_ITEM = '[data-virtual-list-item-key]';
export const MESSAGE_BODY = '.ds-message';

export const ASSISTANT_BODY = '.ds-assistant-message-main-content';
export const THINK_CONTENT = '.ds-think-content';
export const MARKDOWN_ROOT = '.ds-markdown';

/** d-attribute prefix of the up-arrow "send" SVG. */
export const SEND_BUTTON_PATH_SIGNATURE = 'M8.3125 0.981587';

/** d-attribute prefix of the document/paste icon — the first button in the
 * row of action buttons below an assistant message ("Copy"). Clicking it
 * makes DeepSeek call navigator.clipboard.writeText() with the canonical
 * markdown for that message; our MAIN-world clipboard-tap captures that. */
export const COPY_BUTTON_PATH_SIGNATURE = 'M6.14929 4.02032';

/** Visible label on the "New chat" launcher. */
export const NEW_CHAT_LABEL = 'New chat';

/** Marker text DeepSeek shows when its servers are overloaded.  Appears
 * inline next to the user's just-sent message, alongside a retry icon, in
 * place of an assistant response. */
export const BUSY_TEXT_PATTERN = /server is busy/i;

/** d-attribute prefix of the curved-arrow "retry" SVG that DeepSeek renders
 * next to a message during busy-state. The same icon doubles as the per-
 * message "regenerate" button on completed assistant turns — we always
 * scope our query to a specific message item so we don't pick up an old
 * regenerate button. */
export const RETRY_BUTTON_PATH_SIGNATURE = 'M1.272 6.21348';

/** d-attribute prefix of the bottom-row "Regenerate" button on an assistant
 * message. Distinct from RETRY_BUTTON: this lives in the action button
 * row below a completed (or Stopped) message, not next to the user's
 * just-sent question. Used when DeepSeek's own generation stalls and
 * shows "Stopped" instead of producing the response. */
export const REGENERATE_BUTTON_PATH_SIGNATURE = 'M7.92136 0.349152';

/** Visible label DeepSeek shows in the thinking-content header when the
 * model bailed out before finishing — usually because the generation hit
 * an internal hiccup, was cancelled, or otherwise didn't reach the
 * response phase. The normal state shows "Thought for N seconds" here. */
export const STOPPED_LABEL_TEXT = 'Stopped';

export interface DomReadyState {
  textarea: HTMLTextAreaElement | null;
  sendButton: HTMLElement | null;
  loggedIn: boolean;
}

export function probeDomReady(): DomReadyState {
  const textarea =
    (document.querySelector(TEXTAREA) as HTMLTextAreaElement | null) ??
    (document.querySelector(TEXTAREA_FALLBACK) as HTMLTextAreaElement | null);
  const sendButton = findSendButton();
  const loggedIn = !!textarea;
  return { textarea, sendButton, loggedIn };
}

export function findSendButton(): HTMLElement | null {
  const paths = document.querySelectorAll('svg path');
  for (const p of paths) {
    const d = p.getAttribute('d');
    if (d && d.startsWith(SEND_BUTTON_PATH_SIGNATURE)) {
      const btn = p.closest('[role="button"]') as HTMLElement | null;
      if (btn) return btn;
    }
  }
  return null;
}

export function findNewChatButton(): HTMLElement | null {
  const spans = document.querySelectorAll('span');
  for (const s of spans) {
    if ((s.textContent || '').trim() === NEW_CHAT_LABEL) {
      const clickable =
        (s.closest('[role="button"]') as HTMLElement | null) ??
        (s.closest('[tabindex]') as HTMLElement | null) ??
        (s.parentElement as HTMLElement | null);
      if (clickable) return clickable;
    }
  }
  return null;
}

export function isSendEnabled(btn: HTMLElement | null): boolean {
  if (!btn) return false;
  return btn.getAttribute('aria-disabled') !== 'true';
}

/** Locate a "Server is busy" indicator anywhere in the message list. We
 * narrow the search to small text-only leaves to avoid matching against
 * page chrome that happens to contain the phrase. Returns the leaf element
 * (so callers can walk up to find the retry button in the same message
 * item). */
export function findBusyIndicator(): HTMLElement | null {
  const list = document.querySelector(MESSAGE_LIST) ?? document.body;
  const spans = list.querySelectorAll('span, p');
  for (const el of spans) {
    const text = (el.textContent ?? '').trim();
    if (text.length === 0 || text.length > 200) continue;
    if (BUSY_TEXT_PATTERN.test(text)) return el as HTMLElement;
  }
  return null;
}

/** Find DeepSeek's own retry button inside the message item that contains
 * `busyEl`. Returns null if not found. */
export function findRetryButtonNear(busyEl: HTMLElement): HTMLElement | null {
  const item = busyEl.closest(MESSAGE_ITEM) as HTMLElement | null;
  if (!item) return null;
  const paths = item.querySelectorAll('svg path');
  for (const p of paths) {
    const d = p.getAttribute('d');
    if (d && d.startsWith(RETRY_BUTTON_PATH_SIGNATURE)) {
      const btn = p.closest('[role="button"]') as HTMLElement | null;
      if (btn) return btn;
    }
  }
  return null;
}

/** Find DeepSeek's per-message "Copy" button inside a virtual-list message
 * item. The action button row only renders once the message is complete,
 * so callers should only invoke this after stability detection has fired. */
export function findCopyButtonIn(messageItem: HTMLElement): HTMLElement | null {
  return findButtonByPathPrefixIn(messageItem, COPY_BUTTON_PATH_SIGNATURE);
}

/** Find DeepSeek's per-message "Regenerate" button — the second button in
 * the action-row below an assistant message. Returns null if the row
 * hasn't rendered yet (i.e., the message is still streaming). */
export function findRegenerateButtonIn(messageItem: HTMLElement): HTMLElement | null {
  return findButtonByPathPrefixIn(messageItem, REGENERATE_BUTTON_PATH_SIGNATURE);
}

/** Detect the "Stopped" indicator inside an assistant message item. If
 * the message generation aborted before reaching the response phase,
 * DeepSeek replaces the normal "Thought for N seconds" label with
 * "Stopped" in the thinking-content header. */
export function findStoppedIndicatorIn(messageItem: HTMLElement): HTMLElement | null {
  const spans = messageItem.querySelectorAll('span');
  for (const el of spans) {
    if (el.closest('button')) continue;
    const t = (el.textContent ?? '').trim();
    if (t === STOPPED_LABEL_TEXT) return el as HTMLElement;
  }
  return null;
}

function findButtonByPathPrefixIn(scope: HTMLElement, pathPrefix: string): HTMLElement | null {
  const paths = scope.querySelectorAll('svg path');
  for (const p of paths) {
    const d = p.getAttribute('d');
    if (d && d.startsWith(pathPrefix)) {
      const btn = p.closest('[role="button"]') as HTMLElement | null;
      if (btn) return btn;
    }
  }
  return null;
}

/** Convert a rendered DeepSeek assistant-message DOM tree back into a
 * markdown-like string. We preserve code blocks as triple-backtick fences
 * with their language tag (so our agent-command parser can find them) and
 * insert paragraph breaks after block elements. We don't try to recover
 * inline emphasis / link syntax — only the structural bits the parser cares
 * about.
 *
 * DeepSeek-specific notes:
 *   - Fenced code blocks render as `<div class="md-code-block">` containing
 *     a banner (with language label + Copy/Download buttons) and a `<pre>`
 *     whose direct child is a `<span>`, NOT a `<code>` element. We special-
 *     case this container so banner text doesn't leak into the prose and
 *     the language label is captured for the parser.
 *   - Inline code is a plain `<code>` outside any `<pre>` — handled as
 *     backtick-wrapped text below.
 */
export function extractMarkdownFromDom(root: HTMLElement): string {
  const parts: string[] = [];
  visit(root);
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    // DeepSeek code-block container: handle as one unit and skip recursion.
    if (node.classList.contains('md-code-block')) {
      const lang = extractDeepseekCodeLang(node);
      const pre = node.querySelector('pre');
      const text = (pre?.textContent ?? '').replace(/\s+$/g, '');
      parts.push(`\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`);
      return;
    }
    if (tag === 'pre') {
      // Generic <pre> outside DeepSeek's wrapper (defensive — keeps the
      // function usable on other chatbots / sites later).
      const code = node.querySelector('code');
      let lang = '';
      if (code) {
        const m = (code.className || '').match(/language-([A-Za-z0-9_-]+)/);
        if (m) lang = m[1];
      }
      const text = ((code?.textContent ?? node.textContent ?? '') || '').replace(/\s+$/g, '');
      parts.push(`\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`);
      return;
    }
    if (tag === 'code' && !node.closest('pre')) {
      parts.push('`' + (node.textContent ?? '') + '`');
      return;
    }
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    // Skip SVG subtrees — DeepSeek renders decorative corner SVGs inside
    // code-block containers that we've already handled above, but other
    // assistants may sprinkle inline SVG icons too. We never want their
    // tag soup leaking into the markdown.
    if (tag === 'svg') return;
    for (const child of Array.from(node.childNodes)) visit(child);
    if (/^(p|div|h[1-6]|li|hr|blockquote|tr)$/i.test(tag)) parts.push('\n');
  }
}

/** Extract the language label from a DeepSeek `.md-code-block` container.
 * The banner DOM is:
 *
 *   <div class="md-code-block-banner ...">
 *     <div>
 *       <div><span class="...">agent-command</span></div>   ← lang
 *       <div>
 *         <button>... <span class="code-info-button-text">Copy</span></button>
 *         <button>... <span class="code-info-button-text">Download</span></button>
 *       </div>
 *     </div>
 *   </div>
 *
 * We pick the first non-empty `<span>` that is NOT inside a `<button>` and
 * whose text doesn't match a known button label. The hashed wrapper classes
 * (`d813de27`, `_121d384`, …) rotate across deploys so we lean on structural
 * positioning instead.
 */
function extractDeepseekCodeLang(container: HTMLElement): string {
  const banner = container.querySelector('.md-code-block-banner');
  if (!banner) return '';
  const KNOWN_BUTTON_LABELS = /^(copy|download|copied|复制|下载)$/i;
  for (const el of banner.querySelectorAll('span')) {
    if (el.closest('button')) continue;
    const t = (el.textContent ?? '').trim();
    if (!t) continue;
    if (t.length > 60) continue;
    if (KNOWN_BUTTON_LABELS.test(t)) continue;
    return t;
  }
  return '';
}
