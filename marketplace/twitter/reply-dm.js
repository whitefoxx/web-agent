import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';

// Cross-navigation scratchpad (hot-plug trampoline). Installed func adapters run
// in-page and are re-executed from the top after every page.goto, so local vars
// don't survive a navigation. This WRITE-LOOP adapter navigates to one DM
// conversation per send; without state it would re-scrape the inbox and restart
// the loop on every reinject (ping-pong) and risk DOUBLE-SENDING. To make the
// loop trampoline-safe we drive it as a URL/stash state machine: the inbox list
// + cursor + accumulated results live in the tab's sessionStorage (same-origin
// x.com survives same-site navigation+reinject). Each replay processes exactly
// the conversation at `cursor`, advances the cursor, stashes, then navigates to
// the next — so a reinject resumes (monotonic forward) instead of restarting.
// See docs/adapter-hot-plug.md §10.22. Scripts are guarded so a page that blocks
// storage degrades to a clear error rather than throwing.
function buildScratchSetScript(key, jsonValue) {
    return `(() => { try { sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(jsonValue)}); return true; } catch (e) { return false; } })()`;
}
function buildScratchGetScript(key) {
    return `(() => { try { return sessionStorage.getItem(${JSON.stringify(key)}); } catch (e) { return null; } })()`;
}
function buildScratchClearScript(key) {
    return `(() => { try { sessionStorage.removeItem(${JSON.stringify(key)}); return true; } catch (e) { return false; } })()`;
}
cli({
    site: 'twitter',
    name: 'reply-dm',
    access: 'write',
    description: 'Send a message to recent DM conversations',
    domain: 'x.com',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'text', type: 'string', required: true, positional: true, help: 'Message text to send (e.g. "我的微信 wxkabi")' },
        { name: 'max', type: 'int', required: false, default: 20, help: 'Maximum number of conversations to reply to (default: 20)' },
        { name: 'skip-replied', type: 'boolean', required: false, default: true, help: 'Skip conversations where you already sent the same text (default: true)' },
        { name: 'timeout', type: 'int', required: false, default: 600, help: 'Max seconds for the overall command (default: 600 — batch op)' },
    ],
    columns: ['index', 'status', 'user', 'message'],
    func: async (page, kwargs) => {
        if (!page)
            throw new CommandExecutionError('Browser session required for twitter reply-dm');
        const messageText = kwargs.text;
        const maxSend = kwargs.max ?? 20;
        const skipReplied = kwargs['skip-replied'] !== false;
        // Per-adapter scratch key (§10.22): unique so it can't collide with any
        // other adapter's stash in the same tab's sessionStorage.
        const SCRATCH_KEY = '__webchat_twitter_reply_dm__';

        // -- Inbox list scrape script (unchanged extraction logic) -------------
        const buildConvListScript = (needed) => `(async () => {
      try {
        // Wait for initial items
        let attempts = 0;
        while (attempts < 10) {
          const items = document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]');
          if (items.length > 0) break;
          await new Promise(r => setTimeout(r, 1000));
          attempts++;
        }

        // Scroll to load more conversations
        const needed = ${needed};
        const seenIds = new Set();
        let noNewCount = 0;

        for (let scroll = 0; scroll < 30; scroll++) {
          const items = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
          items.forEach(el => seenIds.add(el.getAttribute('data-testid')));

          if (seenIds.size >= needed) break;

          // Find the scrollable container and scroll it
          const scrollContainer = document.querySelector('[data-testid="dm-inbox-panel"]') ||
                                  items[items.length - 1]?.closest('[class*="scroll"]') ||
                                  items[items.length - 1]?.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
          // Also try scrolling the last item into view
          if (items.length > 0) {
            items[items.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
          }

          await new Promise(r => setTimeout(r, 1500));

          // Check if new items appeared
          const newItems = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
          const newIds = new Set(newItems.map(el => el.getAttribute('data-testid')));
          if (newIds.size <= seenIds.size) {
            noNewCount++;
            if (noNewCount >= 3) break; // No more loading after 3 tries
          } else {
            noNewCount = 0;
          }
        }

        // Collect all visible conversations
        const finalItems = Array.from(document.querySelectorAll('[data-testid^="dm-conversation-item-"], [data-testid="conversation"]'));
        const conversations = finalItems.map((item, idx) => {
          const testId = item.getAttribute('data-testid') || '';
          const text = item.innerText || '';
          const lines = text.split('\\n').filter(l => l.trim());
          const user = lines[0] || 'Unknown';
          const match = testId.match(/dm-conversation-item-(.+)/);
          const convId = match ? match[1].replace(':', '-') : '';
          const link = item.querySelector('a[href*="/messages/"]');
          const href = link ? link.href : '';
          return { idx, user, convId, href, preview: text.substring(0, 100) };
        });

        return { ok: true, conversations, total: conversations.length };
      } catch(e) {
        return { ok: false, error: String(e), conversations: [], total: 0 };
      }
    })()`;

        // -- Per-conversation send script (unchanged: skip-replied PRE-SEND gate
        //    reads the live DOM for our own message text, the per-conversation
        //    double-send guard). ----------------------------------------------
        const buildSendScript = (conv) => `(async () => {
        try {
          const messageText = ${JSON.stringify(messageText)};
          const skipReplied = ${skipReplied};

          // Get username from conversation
          const dmHeader = document.querySelector('[data-testid="DmActivityContainer"] [dir="ltr"] span') ||
                           document.querySelector('[data-testid="conversation-header"]') ||
                           document.querySelector('[data-testid="DmActivityContainer"] h2');
          const username = dmHeader ? dmHeader.innerText.trim().split('\\\\n')[0] : ${JSON.stringify(conv.user)};

          // Check if we already sent this message
          if (skipReplied) {
            const chatArea = document.querySelector('[data-testid="DmScrollerContainer"]') ||
                             document.querySelector('main');
            const chatText = chatArea ? chatArea.innerText : '';
            if (chatText.includes(messageText)) {
              return { status: 'skipped', user: username, message: 'Already sent this message' };
            }
          }

          // Find the text input
          const input = document.querySelector('[data-testid="dmComposerTextInput"]');
          if (!input) {
            return { status: 'error', user: username, message: 'No message input found' };
          }

          // Focus and type into the DraftEditor
          input.focus();
          await new Promise(r => setTimeout(r, 300));
          document.execCommand('insertText', false, messageText);
          await new Promise(r => setTimeout(r, 500));

          // Click send button
          const sendBtn = document.querySelector('[data-testid="dmComposerSendButton"]');
          if (!sendBtn) {
            return { status: 'error', user: username, message: 'No send button found' };
          }

          sendBtn.click();
          await new Promise(r => setTimeout(r, 1500));

          return { status: 'sent', user: username, message: 'Message sent: ' + messageText };
        } catch(e) {
          return { status: 'error', user: 'system', message: String(e) };
        }
      })()`;

        const convUrlFor = (conv) =>
            conv.convId ? `https://x.com/messages/${conv.convId}` : conv.href;

        // ---- State recovery (§10.22) ----------------------------------------
        // The stash is the single source of truth for "are we mid-loop?". If it
        // exists, a prior stage already built the inbox list + initialized the
        // cursor, and we must NOT re-goto /messages or re-scrape (that would
        // ping-pong and reorder the inbox). If it's absent, we are at stage 0.
        const stashedRaw = await page.evaluate(buildScratchGetScript(SCRATCH_KEY));
        let state = null;
        if (stashedRaw) {
            try {
                state = JSON.parse(stashedRaw);
            } catch {
                state = null;
            }
        }

        if (!state) {
            // Stage 0: build the conversation list ONCE. This goto + scrape only
            // run on the initial entry (no stash yet); per-conversation replays
            // recover the list from the stash and never re-run this block.
            await page.goto('https://x.com/messages');
            await page.wait({ selector: '[data-testid="primaryColumn"]' });
            const needed = maxSend + 10; // extra buffer for skips
            const convList = await page.evaluate(buildConvListScript(needed));
            if (!convList?.ok || !convList.conversations?.length) {
                // Nothing to do — no stash to leave behind.
                return [{ index: 1, status: 'info', user: 'System', message: 'No conversations found' }];
            }
            // Filter to addressable conversations up front so the cursor walks a
            // stable, replay-identical list.
            const conversations = convList.conversations.filter((c) => !!convUrlFor(c));
            state = { conversations, cursor: 0, sentCount: 0, results: [] };
            await page.evaluate(buildScratchSetScript(SCRATCH_KEY, JSON.stringify(state)));
        }

        // ---- Loop body: process exactly ONE conversation per replay ----------
        // Each iteration: goto conv[cursor] (no-op on the replay already there),
        // send-with-skip-check, record, advance cursor, STASH the advanced
        // cursor, then goto the next conv (reinject → resume at cursor+1). The
        // stash is written BEFORE the next navigation so a reinject can never
        // reprocess an already-counted conversation. And the send is guarded by
        // skip-replied (reads our own delivered message in the live DOM), so
        // even a mis-stepped cursor cannot double-send. SINGLE-SHOT.
        while (state.cursor < state.conversations.length && state.sentCount < maxSend) {
            const conv = state.conversations[state.cursor];
            const convUrl = convUrlFor(conv);

            await page.goto(convUrl); // reinject → func restarts, recovers stash, lands here on `conv`
            await page.wait(3);

            const sendResult = await page.evaluate(buildSendScript(conv));

            if (sendResult?.status === 'sent') {
                state.sentCount++;
                state.results.push({
                    index: state.sentCount,
                    status: 'sent',
                    user: sendResult.user || conv.user,
                    message: sendResult.message,
                });
            } else if (sendResult?.status === 'skipped') {
                state.results.push({
                    index: state.results.length + 1,
                    status: 'skipped',
                    user: sendResult.user || conv.user,
                    message: sendResult.message,
                });
            }

            // Advance + persist BEFORE the next navigation so the reinject that
            // lands on the next conversation skips this (already-done) one.
            state.cursor++;
            await page.evaluate(buildScratchSetScript(SCRATCH_KEY, JSON.stringify(state)));

            await page.wait(1);
        }

        // ---- Done: recover final results, clear the stash, return ------------
        // Re-read the stash (it's the authoritative accumulator across reinjects)
        // then clear the key so a fresh invocation starts clean.
        const finalRaw = await page.evaluate(buildScratchGetScript(SCRATCH_KEY));
        await page.evaluate(buildScratchClearScript(SCRATCH_KEY));
        let finalState = state;
        if (finalRaw) {
            try {
                finalState = JSON.parse(finalRaw);
            } catch {
                finalState = state;
            }
        }
        if (!finalState) {
            throw new CommandExecutionError('twitter reply-dm lost its conversation cursor across navigation (sessionStorage unavailable?).');
        }
        const results = finalState.results || [];
        if (results.length === 0) {
            results.push({ index: 0, status: 'info', user: 'System', message: 'No conversations processed' });
        }
        return results;
    }
});
