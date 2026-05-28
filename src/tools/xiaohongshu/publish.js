/**
 * Hand-ported from opencli/clis/xiaohongshu/publish.js.
 *
 * v0 differences from upstream:
 * - Image files come from `page.getAttachments()` (user-attached via the
 *   side panel's 📎 button), NOT from a `--images` filesystem path arg.
 *   The LLM can't pass binary data through tool args; the user supplies
 *   the images out-of-band before invoking publish.
 * - Upload uses the JS DataTransfer approach only (no CDP
 *   DOM.setFileInputFiles fallback). Per-image base64 round-trip means
 *   total payload is constrained by Runtime.evaluate string limits
 *   (~10 MB practical ceiling).
 * - Topics (hashtags) NOT supported in this port — fragile UI flow that
 *   isn't worth porting until someone needs it.
 * - **Does NOT auto-click the final 发布/暂存 button.** After filling
 *   images + title + content, the adapter STOPS and returns. The user
 *   reviews the draft in the tab and clicks Publish manually. This is a
 *   deliberate safety boundary — silent automated posting is too risky
 *   for an LLM tool to wield.
 *
 * NOT byte-identical with opencli upstream.
 */

import { cli, Strategy } from '../../runtime/registry.js';
import { CliError, ArgumentError, NeedsAttachmentsError } from '../../runtime/errors.js';

const PUBLISH_URL =
  'https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image';
const MAX_IMAGES = 9;
const MAX_TITLE_LEN = 20;
const UPLOAD_SETTLE_MS = 3000;

const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Selectors ordered MOST → LEAST specific. xhs creator-center's 2026 UI
// renders the title as `<input class="d-text" type="text"
// placeholder="填写标题会有更多赞哦">` inside a `.d-input` wrapper that
// also carries a `--color-text-title` class. Prioritizing these wins
// against unrelated inputs (cover title, search, etc.) that could share
// looser selectors like `input[placeholder*="标题"]`.
const TITLE_SELECTORS = [
  'input[placeholder*="填写标题"]',
  'input[placeholder*="标题会有更多赞"]',
  '.d-input.\\--color-text-title input',
  '.d-input input.d-text',
  '[contenteditable="true"][placeholder*="标题"]',
  '[contenteditable="true"][placeholder*="赞"]',
  '[contenteditable="true"][class*="title"]',
  'input[maxlength="20"]',
  'input[class*="title"]',
  'input[placeholder*="标题"]',
  '.title-input input',
  '.note-title input',
  'input[maxlength]',
];

const CONTENT_SELECTORS = [
  '[contenteditable="true"][class*="content"]',
  '[contenteditable="true"][class*="editor"]',
  '[contenteditable="true"][placeholder*="描述"]',
  '[contenteditable="true"][placeholder*="正文"]',
  '[contenteditable="true"][placeholder*="内容"]',
  '.note-content [contenteditable="true"]',
  '.editor-content [contenteditable="true"]',
  '[contenteditable="true"]:not([placeholder*="标题"]):not([placeholder*="赞"])',
];

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const SELECT_IMAGE_TAB_JS = `
  (() => {
    const isVisible = (el) => {
      if (!el || el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const normalize = (v) => (v || '').replace(/\\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], a, label, div, span, li'));
    const targets = ['上传图文', '图文', '图片'];
    for (const target of targets) {
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.innerText || node.textContent || '');
        if (!text || text.includes('视频')) continue;
        if (text === target || text.startsWith(target)) {
          const clickable = node.closest('button, [role="tab"], [role="button"], a, label') || node;
          clickable.click();
          return { ok: true, target, text };
        }
      }
    }
    return { ok: false };
  })()
`;

const WAIT_FOR_EDIT_FORM_JS = (selectors) => `
  new Promise((resolve) => {
    const sels = ${JSON.stringify(selectors)};
    const detect = () => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return true;
      }
      return false;
    };
    if (detect()) return resolve(true);
    const observer = new MutationObserver(() => {
      if (detect()) { observer.disconnect(); resolve(true); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(false); }, 12000);
  })
`;

function buildUploadJs(images) {
  // images: Array<{name, mimeType, base64}>
  return `
    (async () => {
      const images = ${JSON.stringify(images)};
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const input = inputs.find((el) => {
        const accept = el.getAttribute('accept') || '';
        return /image|\\.jpg|\\.jpeg|\\.png|\\.gif|\\.webp/i.test(accept);
      });
      if (!input) return { ok: false, error: 'No image file input found on page' };
      const dt = new DataTransfer();
      for (const img of images) {
        const binary = atob(img.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: img.mimeType });
        dt.items.add(new File([blob], img.name, { type: img.mimeType }));
      }
      Object.defineProperty(input, 'files', { value: dt.files, writable: false });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, count: dt.files.length };
    })()
  `;
}

/**
 * Verify what's actually visible in the field. Used after the DOM-based
 * fill to detect React-controlled fields that accepted our `insertText`
 * but then re-rendered to their previous (empty) state.
 */
function buildReadJs(selectors) {
  return `
    (() => {
      const sels = ${JSON.stringify(selectors)};
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el || el.offsetParent === null) continue;
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
          return (el.innerText || el.textContent || '').trim();
        }
      }
      return '';
    })()
  `;
}

/**
 * Focus the first matching element in page context, without dispatching
 * any synthetic input events (those can trigger Vue re-renders that lose
 * focus before the upcoming CDP keystrokes land). Returns diagnostic
 * info so failures can be debugged.
 */
function buildFocusJs(selectors) {
  return `
    (() => {
      const sels = ${JSON.stringify(selectors)};
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el || el.offsetParent === null) continue;
          el.focus();
          if (typeof el.select === 'function') { try { el.select(); } catch {} }
          return {
            ok: true,
            tag: el.tagName,
            className: (el.className || '').toString().slice(0, 80),
            focused: document.activeElement === el,
            isReadOnly: !!el.readOnly,
            isDisabled: !!el.disabled,
          };
        }
      }
      return { ok: false };
    })()
  `;
}

/**
 * Fill a field with retry. Strategy:
 *   1. DOM fill (buildFillJs) — fastest, works for plain inputs.
 *   2. Read back via buildReadJs. If non-empty, done.
 *   3. If empty (framework reset our value), focus + CDP keystroke
 *      synthesis (page.insertText → per-char Input.dispatchKeyEvent).
 *      Frameworks observe these as real typing and update state.
 *   4. Up to 3 retry attempts with the CDP path before giving up.
 */
/**
 * Two-phase stability check: read at 0.5s AND again at 1.5s. Only return
 * success if both reads show non-empty content. Catches frameworks like
 * Vue that lazily reset value after the initial settle, which made our
 * earlier single-readback report false success.
 */
async function readBackStable(page, selectors) {
  await page.wait({ time: 0.5 });
  const r1 = await page.evaluate(buildReadJs(selectors));
  if (typeof r1 !== 'string' || r1.trim().length === 0) return '';
  await page.wait({ time: 1.0 });
  const r2 = await page.evaluate(buildReadJs(selectors));
  if (typeof r2 !== 'string' || r2.trim().length === 0) return '';
  return r2;
}

async function fillFieldWithCdpFallback(page, selectors, text, fieldName) {
  // S1: DOM fill (fast path; works for non-controlled inputs and
  // contenteditables that accept execCommand insertText).
  const filled = await page.evaluate(buildFillJs(selectors, text));
  if (!filled?.ok) {
    throw new CliError(
      'FILL_FAILED',
      `${fieldName} field not found (selector may have changed). Open creator.xiaohongshu.com and check the page layout.`,
    );
  }
  if ((await readBackStable(page, selectors)).trim().length > 0) return;

  // Escalating CDP strategies. Each retries focus + types differently.
  let lastFocus = null;
  const strategies = [
    { name: 'CDP batch (Input.insertText)', mode: 'batch' },
    { name: 'CDP per-char (keyDown/char/keyUp)', mode: 'char' },
    { name: 'CDP per-char retry', mode: 'char' },
  ];
  for (const strat of strategies) {
    lastFocus = await page.evaluate(buildFocusJs(selectors));
    if (!lastFocus?.ok) {
      throw new CliError(
        'FILL_FAILED',
        `${fieldName} field disappeared before ${strat.name}.`,
      );
    }
    await page.insertText(text, { mode: strat.mode });
    if ((await readBackStable(page, selectors)).trim().length > 0) return;
  }
  throw new CliError(
    'FILL_FAILED',
    `${fieldName} still empty after DOM + CDP batch + 2× CDP keystroke attempts. ` +
      `Diagnostic: tag=${lastFocus?.tag} class="${lastFocus?.className}" focused=${lastFocus?.focused} readOnly=${lastFocus?.isReadOnly} disabled=${lastFocus?.isDisabled}. ` +
      `Either the framework rejects all synthetic input, or focus is being stolen by another element after our focus() call.`,
  );
}

function buildFillJs(selectors, text) {
  return `
    (() => {
      const sels = ${JSON.stringify(selectors)};
      const expectedText = ${JSON.stringify(text)};
      let el = null;
      let kind = null;
      for (const sel of sels) {
        for (const candidate of document.querySelectorAll(sel)) {
          if (!candidate || candidate.offsetParent === null) continue;
          el = candidate;
          kind = el.isContentEditable
            ? 'contenteditable'
            : el.tagName === 'TEXTAREA' ? 'textarea' : 'input';
          break;
        }
        if (el) break;
      }
      if (!el) return { ok: false, error: 'no_field' };
      el.focus();
      // Frameworks (especially Vue v-model) often check event instanceof
      // InputEvent — a plain new Event('input') is silently ignored. Use
      // InputEvent with inputType:'insertText' so the controlled-state
      // machine treats it as authentic user input.
      const fireInput = (value) => {
        try {
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: value,
            inputType: 'insertText',
          }));
        } catch {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };
      if (kind === 'input' || kind === 'textarea') {
        const proto = kind === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, expectedText);
        else el.value = expectedText;
        fireInput(expectedText);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: el.value === expectedText, actual: el.value };
      }
      // contenteditable
      el.textContent = '';
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      const inserted = document.execCommand('insertText', false, expectedText);
      if (!inserted) el.textContent = expectedText;
      fireInput(expectedText);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // xhs's contenteditable editor transforms text (emoji → <img>,
      // #hashtag → <a>, newline normalization), so strict equality of
      // innerText vs the input is too brittle. Treat ANY non-empty
      // readback as success — if the editor truncated or formatted, the
      // user will see + fix in the tab before clicking 发布.
      const actual = (el.innerText || el.textContent || '').trim();
      return { ok: actual.length > 0, actual, actualLen: actual.length };
    })()
  `;
}

cli({
  site: 'xiaohongshu',
  name: 'publish',
  access: 'write',
  description:
    '小红书发布图文笔记。**这是一个 card-first 工具：调用后侧边栏会弹出 inline 编辑卡片，用户在卡片里填写/编辑 title + content + 图片**。你的工作只是触发卡片：(a) 用户给了具体内容 → 用他们的 title + content 调用；(b) 用户给了主题但没内容（如"写一篇关于咖啡的"）→ 你起草 title + content 后调用，卡片预填好让用户审；(c) 用户只说"发布"/没给信息 → 用空字符串 title="" content="" 调用，给用户空白卡片自己填。**绝不**在聊天里问用户要图片——卡片处理上传。Continue 后笔记草稿会自动填好到 creator.xiaohongshu.com，用户人工点「发布」按钮收尾。',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  args: [
    { name: 'title', required: true, help: '笔记标题 (≤20 字)' },
    { name: 'content', required: true, positional: true, help: '笔记正文' },
  ],
  columns: ['status', 'detail'],
  func: async (page, kwargs) => {
    const title = String(kwargs.title ?? '').trim();
    const content = String(kwargs.content ?? '').trim();

    // Card-first flow: ALWAYS surface the upload card when there are no
    // attachments yet, regardless of whether title/content are empty. The
    // card IS the input UI for both text + images. Empty title/content
    // just means the user (or LLM) hasn't drafted yet — the card opens
    // blank and the user fills in. Validation runs on the SECOND
    // invocation (post-Continue) when attachments are present.
    const attachments = page.getAttachments();
    if (attachments.length === 0) {
      throw new NeedsAttachmentsError({ minImages: 1, maxImages: MAX_IMAGES });
    }
    if (attachments.length > MAX_IMAGES) {
      throw new ArgumentError(
        `Too many attachments: ${attachments.length} (max ${MAX_IMAGES}).`,
      );
    }

    // Attachments present → this is the real publish attempt. Now we can
    // validate title and content; the card's `canContinue` gate ensures
    // they're non-empty before the user could even click Continue.
    if (!title) throw new ArgumentError('title is required');
    if (title.length > MAX_TITLE_LEN) {
      throw new ArgumentError(`Title is ${title.length} chars — must be ≤ ${MAX_TITLE_LEN}`);
    }
    if (!content) throw new ArgumentError('content is required');
    for (const f of attachments) {
      if (!SUPPORTED_MIME.has(f.type)) {
        throw new ArgumentError(
          `Unsupported image type "${f.type}" for "${f.name}". Allowed: jpg / png / gif / webp.`,
        );
      }
    }

    await page.goto(PUBLISH_URL);
    await page.wait({ time: 2 });

    const url = await page.evaluate('location.href');
    if (!String(url).includes('creator.xiaohongshu.com')) {
      throw new CliError(
        'AUTH_REQUIRED',
        'Redirected away from creator.xiaohongshu.com — session may have expired.',
        'Log into creator.xiaohongshu.com in this Chrome window, then retry.',
      );
    }

    // Click 图文 tab if present
    await page.evaluate(SELECT_IMAGE_TAB_JS);
    await page.wait({ time: 1 });

    // Encode attachments to base64 (in the side-panel side; cheap for ≤10MB total)
    const images = [];
    for (const file of attachments) {
      images.push({
        name: file.name,
        mimeType: file.type,
        base64: await fileToBase64(file),
      });
    }

    const upload = await page.evaluate(buildUploadJs(images));
    if (!upload?.ok) {
      throw new CliError(
        'UPLOAD_FAILED',
        `Image upload failed: ${upload?.error ?? 'unknown'}`,
        'The publish page DOM may have changed, or the file input is gated behind a tab selection step.',
      );
    }

    await page.wait({ time: UPLOAD_SETTLE_MS / 1000 });

    const formReady = await page.evaluate(WAIT_FOR_EDIT_FORM_JS(TITLE_SELECTORS));
    if (!formReady) {
      throw new CliError(
        'FORM_NOT_READY',
        'The editor form did not appear after image upload (page layout may have changed).',
      );
    }

    await fillFieldWithCdpFallback(page, TITLE_SELECTORS, title, 'title');
    await page.wait({ time: 0.5 });
    await fillFieldWithCdpFallback(page, CONTENT_SELECTORS, content, 'content');

    // Intentionally STOP here. User must click the final "发布" button in
    // the creator-center tab themselves — silent automated posting is out
    // of scope for v0.
    return [
      {
        status: '✅ 草稿就绪',
        detail: `已填入: "${title}" · ${attachments.length}张图片 · ${content.length}字正文。请在 creator.xiaohongshu.com tab 核对后**手动点「发布」**按钮。`,
      },
    ];
  },
});
