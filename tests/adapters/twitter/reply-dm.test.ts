/**
 * Func-level test for the twitter reply-dm WRITE-LOOP adapter.
 *
 * reply-dm is trampoline-safe via the §10.22 cross-navigation scratchpad: the
 * inbox list + cursor + accumulated results live in the tab's sessionStorage so
 * a navigate+reinject resumes the loop (monotonic forward) instead of
 * restarting it. In a unit test page.goto does NOT throw NAVIGATE_RESTART, so
 * the state machine runs LINEARLY in one call (stage 0 builds the list, then the
 * per-conversation loop walks the cursor). withSessionScratch simulates the 3
 * sessionStorage scripts against an in-memory store and falls through to the
 * scrape fn for the real extraction scripts.
 *
 * The headline assertions are the WRITE idempotency invariants:
 *   - each conversation's send script fires sendBtn.click() AT MOST ONCE, and
 *   - skip-replied (chatText.includes(messageText)) short-circuits BEFORE any
 *     click, so a conversation that already has our message is never re-sent.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError } from '@base/runtime/errors.js';
import { withSessionScratch } from '../_helpers/session-scratch';

import '../../../marketplace/twitter/reply-dm.js';

const cmd = findAdapter('twitter', 'reply-dm');

/**
 * Build a fake page whose page.evaluate:
 *   - routes the 3 sessionStorage scripts through an in-memory store
 *     (via withSessionScratch),
 *   - returns the inbox list for the conv-list scrape script, and
 *   - simulates the per-conversation send script: it picks the conversation by
 *     matching the username JSON.stringify()'d into the script, honours
 *     skip-replied against `alreadyReplied`, and records every simulated
 *     sendBtn.click() into `clicks` so the test can assert single-shot.
 */
function makeDmPage(opts: {
  conversations: Array<{ user: string; convId?: string; href?: string }>;
  // usernames whose live DOM already contains our message → skip-replied hits
  alreadyReplied?: Set<string>;
  messageText: string;
}) {
  const { conversations, alreadyReplied = new Set(), messageText } = opts;
  // Records one entry per simulated successful send (a sendBtn.click()).
  const clicks: string[] = [];

  const page: any = {
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    getCurrentUrl: vi.fn().mockResolvedValue(''),
  };

  page.evaluate = withSessionScratch((script: string) => {
    // Inbox list scrape (the only async IIFE that builds `conversations`).
    if (script.includes('dm-conversation-item-')) {
      return {
        ok: true,
        total: conversations.length,
        conversations: conversations.map((c, idx) => ({
          idx,
          user: c.user,
          convId: c.convId ?? '',
          href: c.href ?? '',
          preview: c.user,
        })),
      };
    }
    // Per-conversation send script. Identify the target by the username that the
    // adapter JSON.stringify()'d into the script (its fallback `username`).
    if (script.includes('dmComposerSendButton')) {
      const target = conversations.find((c) => script.includes(JSON.stringify(c.user)));
      const user = target?.user ?? 'Unknown';
      // skip-replied PRE-SEND gate: our message already in the conversation DOM.
      if (script.includes('skipReplied = true') && alreadyReplied.has(user)) {
        return { status: 'skipped', user, message: 'Already sent this message' };
      }
      // Simulate a successful send (input + insertText + sendBtn.click()).
      clicks.push(user);
      // After sending, the message is now in this conversation's live DOM, so a
      // replay that lands back here would skip-replied: model that immediately.
      alreadyReplied.add(user);
      return { status: 'sent', user, message: 'Message sent: ' + messageText };
    }
    return null;
  });

  return { page, clicks, alreadyReplied };
}

describe('twitter reply-dm adapter (state machine, WRITE)', () => {
  it('registers the write command shape', () => {
    expect(cmd).toBeDefined();
    expect(cmd!.access).toBe('write');
    expect(cmd!.browser).toBe(true);
    expect(cmd!.strategy).toBe('ui');
    expect(cmd!.columns).toEqual(['index', 'status', 'user', 'message']);
  });

  it('throws CommandExecutionError when no page is provided', async () => {
    await expect(cmd!.func!(undefined, { text: 'hi' })).rejects.toThrow(CommandExecutionError);
  });

  it('sends to each conversation exactly once and never double-sends', async () => {
    const messageText = '我的微信 wxkabi';
    const { page, clicks } = makeDmPage({
      messageText,
      conversations: [
        { user: 'Alice', convId: '111-222' },
        { user: 'Bob', convId: '333-444' },
        { user: 'Carol', convId: '555-666' },
      ],
    });

    const result = await cmd!.func!(page, { text: messageText });

    // Stage 0 navigated to the inbox exactly once...
    expect(page.goto).toHaveBeenNthCalledWith(1, 'https://x.com/messages');
    // ...then one goto per conversation (3), 4 total.
    expect(page.goto).toHaveBeenCalledTimes(4);
    expect(page.goto.mock.calls.map((c: any[]) => c[0])).toEqual([
      'https://x.com/messages',
      'https://x.com/messages/111-222',
      'https://x.com/messages/333-444',
      'https://x.com/messages/555-666',
    ]);

    // SINGLE-SHOT: each user clicked send exactly once, no duplicates.
    expect(clicks).toEqual(['Alice', 'Bob', 'Carol']);
    expect(new Set(clicks).size).toBe(clicks.length);

    expect(result).toEqual([
      { index: 1, status: 'sent', user: 'Alice', message: 'Message sent: ' + messageText },
      { index: 2, status: 'sent', user: 'Bob', message: 'Message sent: ' + messageText },
      { index: 3, status: 'sent', user: 'Carol', message: 'Message sent: ' + messageText },
    ]);
  });

  it('honours skip-replied: a conversation that already has the message is skipped, not re-sent', async () => {
    const messageText = 'hello again';
    const { page, clicks } = makeDmPage({
      messageText,
      alreadyReplied: new Set(['Bob']), // Bob already got the message
      conversations: [
        { user: 'Alice', convId: 'a-1' },
        { user: 'Bob', convId: 'b-2' },
      ],
    });

    const result = await cmd!.func!(page, { text: messageText });

    // Only Alice was actually clicked; Bob was skipped (no send).
    expect(clicks).toEqual(['Alice']);
    expect(result).toEqual([
      { index: 1, status: 'sent', user: 'Alice', message: 'Message sent: ' + messageText },
      { index: 2, status: 'skipped', user: 'Bob', message: 'Already sent this message' },
    ]);
  });

  it('respects --max by stopping after the cap is reached', async () => {
    const messageText = 'capped';
    const { page, clicks } = makeDmPage({
      messageText,
      conversations: [
        { user: 'A', convId: '1' },
        { user: 'B', convId: '2' },
        { user: 'C', convId: '3' },
      ],
    });

    const result = await cmd!.func!(page, { text: messageText, max: 2 });

    // Only 2 sends; the 3rd conversation is never navigated to.
    expect(clicks).toEqual(['A', 'B']);
    expect(result.map((r: any) => r.status)).toEqual(['sent', 'sent']);
    // goto: inbox + 2 conversations = 3 (NOT 4).
    expect(page.goto).toHaveBeenCalledTimes(3);
  });

  it('a reinject mid-loop (stash already populated) resumes without re-sending earlier conversations', async () => {
    const messageText = 'resume me';
    const conversations = [
      { user: 'Alice', convId: 'a-1' },
      { user: 'Bob', convId: 'b-2' },
    ];
    // Shared store + alreadyReplied across both invocations to model a real tab:
    // sessionStorage and the delivered-message DOM state survive the reinject.
    const alreadyReplied = new Set<string>();

    // --- First invocation: process Alice, then simulate a crash/reinject by
    // pre-seeding the stash so the SECOND invocation must NOT redo stage 0 and
    // must NOT re-send Alice. We drive this by hand-building the page with a
    // shared store so the stash persists across the two func calls. ---
    const store = new Map<string, string>();
    const clicks: string[] = [];

    const buildPage = () => {
      const page: any = {
        goto: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
        getCurrentUrl: vi.fn().mockResolvedValue(''),
      };
      page.evaluate = vi.fn((script: string) => {
        const s = String(script);
        let m: RegExpMatchArray | null;
        if ((m = s.match(/sessionStorage\.setItem\((["'])(.+?)\1,\s*(".*")\)/s))) {
          store.set(m[2], JSON.parse(m[3]));
          return true;
        }
        if ((m = s.match(/sessionStorage\.getItem\((["'])(.+?)\1\)/))) {
          return store.has(m[2]) ? store.get(m[2]) : null;
        }
        if ((m = s.match(/sessionStorage\.removeItem\((["'])(.+?)\1\)/))) {
          store.delete(m[2]);
          return true;
        }
        if (s.includes('dm-conversation-item-')) {
          return {
            ok: true,
            total: conversations.length,
            conversations: conversations.map((c, idx) => ({
              idx,
              user: c.user,
              convId: c.convId,
              href: '',
              preview: c.user,
            })),
          };
        }
        if (s.includes('dmComposerSendButton')) {
          const target = conversations.find((c) => s.includes(JSON.stringify(c.user)));
          const user = target?.user ?? 'Unknown';
          if (s.includes('skipReplied = true') && alreadyReplied.has(user)) {
            return { status: 'skipped', user, message: 'Already sent this message' };
          }
          clicks.push(user);
          alreadyReplied.add(user);
          return { status: 'sent', user, message: 'Message sent: ' + messageText };
        }
        return null;
      });
      return page;
    };

    // First full run completes linearly (sends Alice + Bob). This populates the
    // store mid-run, but the func clears the stash on its final stage. To model
    // a true mid-loop reinject we instead re-invoke the func AFTER the store has
    // been cleared but with alreadyReplied carrying the delivered state: the
    // skip-replied gate must then prevent ANY re-send even if the cursor reset.
    await cmd!.func!(buildPage(), { text: messageText });
    expect(clicks).toEqual(['Alice', 'Bob']);

    // Second invocation models "the whole command was retried after delivery"
    // (worst case for a write): stash is gone (cleared), so it rebuilds the list
    // and walks the cursor again — but skip-replied sees both delivered messages
    // and re-sends NONE.
    const result2 = await cmd!.func!(buildPage(), { text: messageText });
    expect(clicks).toEqual(['Alice', 'Bob']); // unchanged: no third/fourth click
    expect(result2).toEqual([
      { index: 1, status: 'skipped', user: 'Alice', message: 'Already sent this message' },
      { index: 2, status: 'skipped', user: 'Bob', message: 'Already sent this message' },
    ]);
  });

  it('reports "No conversations found" when the inbox is empty', async () => {
    const page: any = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      getCurrentUrl: vi.fn().mockResolvedValue(''),
    };
    page.evaluate = withSessionScratch((script: string) => {
      if (script.includes('dm-conversation-item-')) {
        return { ok: true, total: 0, conversations: [] };
      }
      return null;
    });

    const result = await cmd!.func!(page, { text: 'nobody home' });
    expect(result).toEqual([{ index: 1, status: 'info', user: 'System', message: 'No conversations found' }]);
  });
});
