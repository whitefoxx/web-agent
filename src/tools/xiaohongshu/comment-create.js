/**
 * Xiaohongshu comment composer — drafts (and optionally sends) comments and
 * replies on a note.
 *
 * Targeting is by comment id (the `<div id="comment-{hex}">` id, surfaced by
 * `opencli xiaohongshu comments` as the `comment_id` column):
 *   - no --reply-to  → a new top-level comment
 *   - --reply-to <id> → a threaded reply to that comment
 *   - --replies <json> → batch: reply to / comment several at once
 *
 * Sending:
 *   - default            → writes the text only, does NOT click 发送
 *   - --send             → also clicks 发送 after writing (single mode)
 *   - --replies (batch)  → always sends (one composer can hold one draft, so
 *                          batch must fill→send→next)
 *
 * DOM facts (verified with `opencli explore` against a live note):
 *   - editor: the single `<p id="content-textarea" contenteditable data-tribute>`
 *   - each comment: `<div id="comment-{24hex}" class="comment-item">`
 *   - per-comment reply trigger: `<div class="reply icon-container">` (older
 *     layout: a text `<span>回复</span>`)
 *   - send button: `<button class="btn submit">发送</button>` (`gray` = disabled)
 *   - XHS activates UI on pointer/mousedown — a plain `el.click()` is ignored,
 *     so every interaction dispatches the full mouse sequence.
 *   - the editor only registers TRUSTED input — text goes in via CDP typing.
 *
 * Usage:
 *   opencli xiaohongshu comment-create "<signed note URL>" "写点什么"
 *   opencli xiaohongshu comment-create "<signed note URL>" "回复内容" --reply-to <commentId>
 *   opencli xiaohongshu comment-create "<signed note URL>" "写点什么" --send
 *   opencli xiaohongshu comment-create "<signed note URL>" --dry-run
 *   opencli xiaohongshu comment-create "<signed note URL>" \
 *     --replies '[{"id":"<commentId>","text":"回复A"},{"text":"顶层评论"}]'
 */
import { cli, Strategy } from '../../runtime/registry.js';
import { AuthRequiredError, ArgumentError, CliError } from '../../runtime/errors.js';
import { buildNoteUrl } from './note-helpers.js';

/** Selectors for the active comment / reply editor, in priority order. */
const COMMENT_EDITOR_SELECTORS = [
    '#content-textarea',
    'p[contenteditable="true"]',
    '.content-edit [contenteditable="true"]',
    '.engage-bar [contenteditable="true"]',
    '[contenteditable="true"][placeholder*="评论"]',
    '[contenteditable="true"][placeholder*="说点什么"]',
    'textarea[placeholder*="说点什么"]',
    'textarea[placeholder*="评论"]',
];

/**
 * In-page helper source: dispatches the full pointer/mouse-down sequence on an
 * element. XHS activates its UI on `mousedown` — a plain `el.click()` does not
 * open the composer / fire the reply trigger / press 发送.
 */
const FIRE_CLICK_FN = `
  const __fireClick = (el) => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }))
    }
    return true
  }
`;

/** Strip a leading `comment-` prefix and surrounding whitespace from a comment id. */
function normalizeCommentId(raw) {
    return String(raw ?? '').trim().replace(/^comment-/i, '');
}

/** Collapse newlines — XHS comments are single-line and Enter submits. */
function oneLine(text) {
    return String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** Parse and validate the --replies JSON argument into a task list. */
function parseRepliesArg(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ArgumentError('--replies must be a valid JSON array', 'Example: --replies \'[{"id":"<commentId>","text":"回复内容"},{"text":"顶层评论"}]\'');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new ArgumentError('--replies must be a non-empty JSON array', 'Each item is {"id":"<commentId>","text":"..."}; omit "id" for a top-level comment.');
    }
    return parsed.map((entry, i) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ArgumentError(`--replies[${i}] must be an object`, 'Each item is {"id":"<commentId>","text":"..."}.');
        }
        const text = oneLine(entry.text);
        if (!text) {
            throw new ArgumentError(`--replies[${i}].text is required`, 'Every batch entry needs non-empty "text".');
        }
        return { id: normalizeCommentId(entry.id) || undefined, text };
    });
}

cli({
    site: 'xiaohongshu',
    name: 'comment-create',
    access: 'write',
    description: '在小红书笔记下写评论/回复（按评论 ID 定位；默认只写入不发送，--send 才发送，--replies 批量）',
    domain: 'www.xiaohongshu.com',
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    // Keep the tab open so unsent drafts survive for manual review.
    browserSession: { reuse: 'site' },
    args: [
        { name: 'note-id', required: true, positional: true, help: 'Full Xiaohongshu note URL with xsec_token' },
        { name: 'content', required: false, positional: true, help: '评论 / 回复内容（单条模式；--replies / --dry-run 时省略）' },
        { name: 'reply-to', required: false, help: '要回复的评论 ID（来自 `xiaohongshu comments` 的 comment_id 列；省略=顶层评论）' },
        { name: 'replies', required: false, help: '批量 JSON：[{"id":"评论ID","text":"回复内容"},{"text":"顶层评论"}]（批量强制发送）' },
        { name: 'send', type: 'bool', default: false, help: '写入后真正点击「发送」（单条模式；批量模式始终发送）' },
        { name: 'dry-run', type: 'bool', default: false, help: '只展开评论框验证，不写入任何内容' },
    ],
    columns: ['status', 'mode', 'target', 'content'],
    func: async (page, kwargs) => {
        if (!page)
            throw new Error('Browser page required');
        const raw = String(kwargs['note-id']);
        const noteUrl = buildNoteUrl(raw, { commandName: 'xiaohongshu comment-create' });
        const dryRun = Boolean(kwargs['dry-run']);
        const repliesRaw = String(kwargs.replies ?? '').trim();
        const batch = repliesRaw.length > 0;

        // ── Build the task list ───────────────────────────────────────────────
        let tasks;
        if (batch) {
            if (dryRun)
                throw new ArgumentError('--dry-run cannot be combined with --replies', 'Use --dry-run with a single target, or drop it for a batch run.');
            tasks = parseRepliesArg(repliesRaw);
        }
        else {
            const content = oneLine(kwargs.content);
            const replyTo = normalizeCommentId(kwargs['reply-to']);
            if (!content && !dryRun)
                throw new ArgumentError('Positional argument <content> is required', 'Pass the comment text, or use --replies for batch, or --dry-run to only open the box.');
            tasks = [{ id: replyTo || undefined, text: content }];
        }
        // Batch always sends; single mode sends only with --send.
        const willSend = batch || Boolean(kwargs.send);

        // ── Navigate + login / risk-control gate ──────────────────────────────
        await page.goto(noteUrl);
        await page.wait({ time: 2 + Math.random() * 3 });
        const gate = await page.evaluate(`
      (() => {
        /* xhs-comment-create: gate */
        const bodyText = document.body?.innerText || ''
        const loginWall = /登录后查看|请登录/.test(bodyText)
        const securityBlock = /安全限制|访问链接异常/.test(bodyText)
          || /website-login\\/error|error_code=300017|error_code=300031/.test(location.href)
        return { loginWall, securityBlock }
      })()
    `);
        if (gate?.securityBlock) {
            throw new CliError('SECURITY_BLOCK', 'Xiaohongshu security block: the note detail page was blocked by risk control.', 'The page may be temporarily restricted. Try again later or from a different session.');
        }
        if (gate?.loginWall) {
            throw new AuthRequiredError('www.xiaohongshu.com', 'Posting a comment requires login');
        }

        // ── Process each task ─────────────────────────────────────────────────
        const rows = [];
        for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const mode = task.id ? 'reply' : 'comment';
            let target = task.id ? task.id : '(顶层评论)';

            // Open the right composer.
            if (task.id) {
                const opened = await clickCommentReply(page, task.id);
                if (!opened?.ok) {
                    if (opened?.reason === 'not-found') {
                        const sample = (opened.sample || []).join(', ') || 'none loaded';
                        const err = new CliError('TARGET_NOT_FOUND', `Comment id "${task.id}" was not found on this note.`, `Loaded comment ids include: ${sample}. Get ids from \`opencli xiaohongshu comments <note>\`.`);
                        if (batch) {
                            rows.push({ status: `❌ 未找到评论 ${task.id}`, mode, target, content: task.text });
                            continue;
                        }
                        await page.screenshot({ path: '/tmp/xhs_comment_reply_target_debug.png' });
                        throw err;
                    }
                    // no-trigger
                    if (batch) {
                        rows.push({ status: `❌ 评论 ${task.id} 无法打开回复框`, mode, target, content: task.text });
                        continue;
                    }
                    await page.screenshot({ path: '/tmp/xhs_comment_reply_target_debug.png' });
                    throw new CliError('TARGET_NOT_ACTIONABLE', `Found comment "${task.id}" but could not open its reply editor.`, 'The comment UI layout may have changed. Debug screenshot: /tmp/xhs_comment_reply_target_debug.png');
                }
                target = opened.author ? `${opened.author} (${task.id})` : task.id;
            }

            // Ensure the bottom composer is expanded (reply click usually does
            // this already; this is the top-level path + a safety retry).
            const composerActive = await ensureComposerActive(page);
            if (!composerActive)
                await page.screenshot({ path: `/tmp/xhs_comment_activate_debug_${i}.png` });

            // Locate the editor.
            const located = await page.evaluate(`
        (() => {
          /* xhs-comment-create: locate */
          const sels = ${JSON.stringify(COMMENT_EDITOR_SELECTORS)}
          const isVisible = (el) => el instanceof HTMLElement && el.offsetParent !== null
          for (const sel of sels) {
            for (const el of document.querySelectorAll(sel)) {
              if (!isVisible(el)) continue
              const kind = el.isContentEditable
                ? 'contenteditable'
                : (el.tagName === 'TEXTAREA' ? 'textarea' : 'input')
              return { ok: true, sel, kind }
            }
          }
          return { ok: false }
        })()
      `);
            if (!located?.ok) {
                await page.screenshot({ path: '/tmp/xhs_comment_editor_debug.png' });
                throw new CliError('EDITOR_NOT_FOUND', 'Could not find the comment editor on the note page.', 'The XHS comment UI may have changed. Debug screenshot: /tmp/xhs_comment_editor_debug.png');
            }

            // Dry run: report the composer state, write nothing.
            if (dryRun) {
                const send = await inspectSendButton(page);
                return [
                    {
                        status: composerActive && send.found
                            ? '✅ 评论框已展开，「发送」按钮已出现（dry-run，未写入任何内容）'
                            : '⚠️ 评论框未能正确展开（dry-run）',
                        mode,
                        target,
                        content: `评论框已展开=${composerActive} · 编辑器=${located.sel} · 发送按钮=${send.found ? '存在' : '未找到'}`,
                    },
                ];
            }

            // Write the text (trusted CDP typing).
            await fillEditor(page, located.sel, task.text);
            const readback = await readEditor(page, located.sel);
            const send = await inspectSendButton(page);

            if (willSend) {
                const result = await submitComment(page);
                rows.push({
                    status: result.sent
                        ? '✅ 已发送'
                        : `⚠️ 已写入但发送未确认（${result.reason}）— 请在浏览器中检查`,
                    mode,
                    target,
                    content: readback || task.text,
                });
                // Gentle pacing between batch sends.
                if (i < tasks.length - 1)
                    await page.wait({ time: 2 + Math.random() * 2 });
            }
            else {
                let status;
                if (!readback)
                    status = '⚠️ 评论框疑似为空，请在浏览器中确认';
                else if (send.found && !send.enabled)
                    status = '⚠️ 已写入文字，但「发送」按钮仍未激活 — 请在浏览器中检查';
                else
                    status = '✅ 已写入评论框，未发送 — 请在浏览器中确认后手动点击发送（或加 --send）';
                rows.push({ status, mode, target, content: readback || task.text });
            }
        }
        return rows;
    },
});

/**
 * Scroll-load comments, find `#comment-<id>`, and fire its reply trigger.
 *
 * Returns `{ ok, author, overlayGone }` on success, or `{ ok:false, reason }`
 * where reason is `not-found` (with a `sample` of loaded ids) or `no-trigger`.
 */
async function clickCommentReply(page, commentId) {
    return page.evaluate(`
    (async (wantId) => {
      /* xhs-comment-create: open-reply */
      ${FIRE_CLICK_FN}
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const clean = (el) => (el?.textContent || '').replace(/\\s+/g, ' ').trim()
      const idSel = 'div[id="comment-' + wantId + '"]'
      const overlaySel = '.content-edit .not-active.inner-when-not-active'

      // Lazy-load comments until the target id appears (or the list stops growing).
      if (!document.querySelector(idSel)) {
        const findScroller = () => {
          let el = document.querySelector('div[name="list"]')
          while (el && el !== document.body) {
            const oy = getComputedStyle(el).overflowY
            if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) return el
            el = el.parentElement
          }
          return document.scrollingElement || document.documentElement
        }
        const scroller = findScroller()
        for (let i = 0; i < 14; i++) {
          if (document.querySelector(idSel)) break
          const before = document.querySelectorAll('div[id^="comment-"]').length
          scroller.scrollTo(0, scroller.scrollHeight)
          await wait(700 + Math.random() * 700)
          const after = document.querySelectorAll('div[id^="comment-"]').length
          if (after <= before) break
        }
      }

      const comment = document.querySelector(idSel)
      if (!comment) {
        const sample = Array.from(document.querySelectorAll('div[id^="comment-"]'))
          .slice(0, 10).map(c => String(c.id).replace('comment-', ''))
        return { ok: false, reason: 'not-found', sample }
      }
      comment.scrollIntoView({ block: 'center' })
      await wait(350)
      const author = clean(Array.from(comment.querySelectorAll('a[href*="/user/profile/"]'))
        .map(a => clean(a)).find(t => t) || '')

      // The comment's OWN reply trigger (not a nested reply's).
      const own = (el) => el && el.closest('div[id^="comment-"]') === comment
      let trigger = Array.from(comment.querySelectorAll('.reply.icon-container, .icon-container.reply')).find(own)
      if (!trigger) {
        // Older layout: a bare text <span>回复</span>.
        trigger = Array.from(comment.querySelectorAll('span, div')).find(el =>
          el.children.length === 0 && (el.textContent || '').trim() === '回复' && own(el))
      }
      if (!trigger) return { ok: false, reason: 'no-trigger', author }

      let overlayGone = false
      for (let attempt = 0; attempt < 3; attempt++) {
        __fireClick(trigger)
        // Hold focus so the reply composer stays expanded.
        const editor = document.querySelector('#content-textarea')
        if (editor && typeof editor.focus === 'function') editor.focus()
        await wait(800)
        overlayGone = !document.querySelector(overlaySel)
        if (overlayGone) break
      }
      return { ok: true, author, overlayGone }
    })(${JSON.stringify(commentId)})
  `);
}

/**
 * Expand the bottom comment composer (top-level path).
 *
 * Collapsed, `.content-edit` carries a `.not-active.inner-when-not-active`
 * overlay over `#content-textarea`. XHS activates on a pointer/mouse-DOWN
 * sequence — `el.click()` / `page.click()` alone do NOT remove it. The editor
 * must then stay focused, or the composer collapses again and the overlay
 * comes back; so we focus `#content-textarea` right after the sequence.
 * Returns true once the overlay is gone.
 */
async function ensureComposerActive(page) {
    for (let attempt = 0; attempt < 4; attempt++) {
        const state = await page.evaluate(`
      (async () => {
        /* xhs-comment-create: active-check */
        ${FIRE_CLICK_FN}
        const wait = (ms) => new Promise(r => setTimeout(r, ms))
        const overlaySel = '.content-edit .not-active.inner-when-not-active'
        if (!document.querySelector(overlaySel)) return { ready: true }
        const editor = document.querySelector('#content-textarea')
        // Focus the editor first, then fire the pointer/mouse-down sequence
        // on the placeholder overlay (the order a real click produces).
        if (editor && typeof editor.focus === 'function') editor.focus()
        await wait(150)
        const overlay = document.querySelector(overlaySel)
        if (overlay) __fireClick(overlay.querySelector('.inner') || overlay)
        if (editor && typeof editor.focus === 'function') editor.focus()
        await wait(700)
        return { ready: !document.querySelector(overlaySel), hidden: document.visibilityState === 'hidden' }
      })()
    `);
        if (state?.ready)
            return true;
        if (state?.hidden)
            return false; // background tab — XHS's expand animation is frozen
        await page.wait({ time: 0.8 });
    }
    return false;
}

/**
 * Fill the comment editor with `text` without submitting.
 *
 * XHS's comment box is a Tribute.js + Vue contenteditable that only registers
 * TRUSTED input — script-driven `execCommand`/DOM writes are `isTrusted:false`
 * and ignored, so the 发送 button never arms. Primary path: focus + select in
 * page, then drive real keystrokes via CDP `page.insertText`. The DOM path is
 * a last resort for environments without CDP typing.
 */
async function fillEditor(page, sel, text) {
    const prep = await page.evaluate(`
    ((selector) => {
      /* xhs-comment-create: prepare */
      const el = Array.from(document.querySelectorAll(selector))
        .find(node => node instanceof HTMLElement && node.offsetParent !== null)
      if (!el) return { ok: false }
      el.focus()
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.select?.()
      } else {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      return { ok: true }
    })(${JSON.stringify(sel)})
  `);
    if (!prep?.ok) {
        await page.screenshot({ path: '/tmp/xhs_comment_fill_debug.png' });
        throw new CliError('EDITOR_NOT_FOUND', 'The comment editor disappeared before text could be written.', 'Debug screenshot: /tmp/xhs_comment_fill_debug.png');
    }
    let typed = false;
    if (typeof page.insertText === 'function') {
        try {
            await page.insertText(text);
            typed = true;
        }
        catch {
            typed = false;
        }
    }
    if (!typed) {
        await page.evaluate(`
      ((selector, expected) => {
        /* xhs-comment-create: fill */
        const el = Array.from(document.querySelectorAll(selector))
          .find(node => node instanceof HTMLElement && node.offsetParent !== null)
        if (!el) return
        el.focus()
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) setter.call(el, expected)
          else el.value = expected
        } else {
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(el)
          selection?.removeAllRanges()
          selection?.addRange(range)
          if (!document.execCommand('insertText', false, expected)) el.textContent = expected
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: expected, inputType: 'insertText' }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })(${JSON.stringify(sel)}, ${JSON.stringify(text)})
    `);
    }
    await page.wait({ time: 0.8 });
}

/** Read back the editor's current text, normalized. */
async function readEditor(page, sel) {
    return page.evaluate(`
    ((selector) => {
      /* xhs-comment-create: readback */
      const el = Array.from(document.querySelectorAll(selector))
        .find(node => node instanceof HTMLElement && node.offsetParent !== null)
      if (!el) return ''
      const value = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
        ? el.value
        : (el.innerText || el.textContent || '')
      return (value || '').replace(/\\s+/g, ' ').trim()
    })(${JSON.stringify(sel)})
  `);
}

/**
 * Inspect the 发送 button. A genuinely-registered comment makes XHS drop the
 * `gray`/`disabled` state.
 */
async function inspectSendButton(page) {
    return page.evaluate(`
    (() => {
      /* xhs-comment-create: send-check */
      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => el instanceof HTMLElement
          && el.offsetParent !== null
          && (el.textContent || '').trim() === '发送')
      if (!btn) return { found: false }
      const cls = typeof btn.className === 'string' ? btn.className : ''
      const enabled = !btn.disabled
        && btn.getAttribute('disabled') == null
        && !/\\bgray\\b|\\bdisabled\\b/.test(cls)
      return { found: true, enabled }
    })()
  `);
}

/**
 * Press the 发送 button and confirm the comment posted.
 *
 * Success heuristic: after a real send XHS clears `#content-textarea`.
 * Returns `{ sent, reason }`.
 */
async function submitComment(page) {
    const clicked = await page.evaluate(`
    (() => {
      /* xhs-comment-create: send-click */
      ${FIRE_CLICK_FN}
      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => el instanceof HTMLElement
          && el.offsetParent !== null
          && (el.textContent || '').trim() === '发送')
      if (!btn) return { ok: false, reason: 'no-button' }
      const cls = typeof btn.className === 'string' ? btn.className : ''
      if (btn.disabled || /\\bgray\\b|\\bdisabled\\b/.test(cls)) return { ok: false, reason: 'send-disabled' }
      __fireClick(btn)
      return { ok: true }
    })()
  `);
    if (!clicked?.ok)
        return { sent: false, reason: clicked?.reason || 'unknown' };
    await page.wait({ time: 2.5 });
    const after = await page.evaluate(`
    (() => {
      /* xhs-comment-create: send-verify */
      const el = document.querySelector('#content-textarea')
      const text = el ? (el.innerText || el.textContent || '').trim() : ''
      return { editorEmpty: text.length === 0 }
    })()
  `);
    return after?.editorEmpty
        ? { sent: true, reason: '' }
        : { sent: false, reason: 'editor-not-cleared' };
}
