/**
 * Unit tests for the session-state pure helpers + the orchestrator's
 * "tab vanished mid-iteration" pause transition.
 *
 * The actual IndexedDB persistence layer (session-store.ts) is exercised
 * manually in Chrome — vitest runs in node without indexedDB, and our
 * wrapper deliberately no-ops in that case, so importing session.ts in
 * tests is safe but the persistence paths aren't covered.
 */

import { describe, it, expect } from 'vitest';
import {
  isDeepseekIdleUrl,
  makeSession,
  makeSessionId,
  parseConversationUrl,
} from '../src/agent/session';
import { runSession, TabUnavailableError, type Driver } from '../src/agent/orchestrator';

describe('parseConversationUrl', () => {
  it('extracts the UUID from a canonical /a/chat/s/<uuid> URL', () => {
    const r = parseConversationUrl(
      'https://chat.deepseek.com/a/chat/s/b939e551-c798-4fc9-baef-29ac5282237b',
    );
    expect(r).not.toBeNull();
    expect(r?.conversationId).toBe('b939e551-c798-4fc9-baef-29ac5282237b');
    expect(r?.conversationUrl).toBe(
      'https://chat.deepseek.com/a/chat/s/b939e551-c798-4fc9-baef-29ac5282237b',
    );
  });

  it('handles trailing query strings / hashes', () => {
    const r = parseConversationUrl(
      'https://chat.deepseek.com/a/chat/s/b939e551-c798-4fc9-baef-29ac5282237b?foo=1',
    );
    expect(r?.conversationId).toBe('b939e551-c798-4fc9-baef-29ac5282237b');
  });

  it('returns null for the deepseek homepage', () => {
    expect(parseConversationUrl('https://chat.deepseek.com/')).toBeNull();
    expect(parseConversationUrl('https://chat.deepseek.com')).toBeNull();
  });

  it('returns null for non-deepseek URLs', () => {
    expect(parseConversationUrl('https://example.com/a/chat/s/abc')).toBeNull();
    expect(parseConversationUrl(null)).toBeNull();
    expect(parseConversationUrl(undefined)).toBeNull();
  });

  it('rejects suspiciously short UUIDs', () => {
    // 8-char "id" — below the 16-char threshold our regex enforces.
    expect(parseConversationUrl('https://chat.deepseek.com/a/chat/s/abcd1234')).toBeNull();
  });
});

describe('isDeepseekIdleUrl', () => {
  it('recognises the homepage and root-relative paths as idle', () => {
    expect(isDeepseekIdleUrl('https://chat.deepseek.com/')).toBe(true);
    expect(isDeepseekIdleUrl('https://chat.deepseek.com')).toBe(true);
    expect(isDeepseekIdleUrl('https://chat.deepseek.com/?x=1')).toBe(true);
  });

  it('marks /a/chat/s/<uuid> URLs as busy', () => {
    expect(
      isDeepseekIdleUrl('https://chat.deepseek.com/a/chat/s/b939e551-c798-4fc9-baef-29ac5282237b'),
    ).toBe(false);
  });

  it('rejects non-deepseek URLs', () => {
    expect(isDeepseekIdleUrl('https://example.com/')).toBe(false);
    expect(isDeepseekIdleUrl('')).toBe(false);
    expect(isDeepseekIdleUrl(undefined)).toBe(false);
    expect(isDeepseekIdleUrl(null)).toBe(false);
  });
});

describe('makeSession / makeSessionId', () => {
  it('initialises a session with sane defaults', () => {
    const s = makeSession('test-1');
    expect(s.id).toBe('test-1');
    expect(s.status).toBe('idle');
    expect(s.chatbotTabId).toBeNull();
    expect(s.conversationId).toBeNull();
    expect(s.conversationUrl).toBeNull();
    expect(s.pendingPrompt).toBeNull();
    expect(s.pauseReason).toBeNull();
    expect(s.turnsSinceFullPrompt).toBe(0);
    expect(s.iterations).toBe(0);
    expect(s.history).toEqual([]);
    expect(typeof s.createdAt).toBe('number');
    expect(typeof s.updatedAt).toBe('number');
  });

  it('makeSessionId returns unique strings', () => {
    const a = makeSessionId();
    const b = makeSessionId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^s_/);
  });
});

describe('orchestrator paused transition', () => {
  it('transitions to paused (not error) when the driver throws TabUnavailableError mid-iteration', async () => {
    // Side-effect import to register adapters (not used here but
    // buildFirstTurnPrompt iterates registry).
    await import('../src/tools/generic/_all');

    const events: Array<{ type: string; reason?: string }> = [];
    const driver: Driver = {
      async inject() {
        // Simulate the bound tab being closed between scheduling the
        // inject and actually performing it.
        throw new TabUnavailableError('tab_closed', 'simulated');
      },
      async waitForResponse() {
        throw new Error('should not be reached');
      },
      async executeTool() {
        return { ok: true, durationMs: 0 };
      },
      emit(evt) {
        events.push({
          type: evt.type,
          reason: evt.type === 'session_paused' ? evt.reason : undefined,
        });
      },
    };
    const s = makeSession('pause-test');
    await runSession({
      session: s,
      userText: 'hi',
      driver,
      continuation: false,
    });
    expect(s.status).toBe('paused');
    expect(s.pauseReason).toBe('tab_closed');
    expect(s.pendingPrompt).not.toBeNull();
    expect(events.find((e) => e.type === 'session_paused')).toMatchObject({
      type: 'session_paused',
      reason: 'tab_closed',
    });
    // Should NOT emit session_done — the session is parked, not finished.
    expect(events.find((e) => e.type === 'session_done')).toBeUndefined();
  });

  it('Resume re-injects the pending prompt without re-appending the user turn', async () => {
    await import('../src/tools/generic/_all');
    const prompts: string[] = [];
    const driver: Driver = {
      async inject({ text }) {
        prompts.push(text);
      },
      async waitForResponse() {
        return { rawText: '', cleanedText: 'done', commands: [] };
      },
      async executeTool() {
        return { ok: true, durationMs: 0 };
      },
      emit() {},
    };
    const s = makeSession('resume-test');
    s.pendingPrompt = 'queued prompt body';
    const historyBefore = [...s.history];
    await runSession({
      session: s,
      userText: '',
      driver,
      resume: true,
    });
    expect(prompts[0]).toBe('queued prompt body');
    // History unchanged (no user turn appended on resume).
    expect(s.history.length).toBe(historyBefore.length + 1); // +1 for assistant turn from empty response
    expect(s.history.find((t) => t.role === 'user')).toBeUndefined();
  });
});
