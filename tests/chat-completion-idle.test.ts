/**
 * makeIdleGuard — the per-attempt idle watchdog that bounds a stalled LLM
 * endpoint (F-34 hang class). It must: fire only after a quiet period, RESET on
 * every bump() (so a slow/reasoning generation is never killed), forward a user
 * Stop (distinct from a timeout), and clean up its timer on dispose().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeIdleGuard, LLM_IDLE_TIMEOUT_MS } from '../src/agent/chat-completion';

afterEach(() => vi.useRealTimers());

describe('makeIdleGuard', () => {
  it('aborts after the idle timeout with no progress, and reports timedOut', () => {
    vi.useFakeTimers();
    const g = makeIdleGuard(undefined);
    g.bump();
    expect(g.signal.aborted).toBe(false);
    vi.advanceTimersByTime(LLM_IDLE_TIMEOUT_MS - 1);
    expect(g.signal.aborted).toBe(false); // not yet
    vi.advanceTimersByTime(2);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(true);
    g.dispose();
  });

  it('bump() resets the watchdog — a long stream that keeps producing is never killed', () => {
    vi.useFakeTimers();
    const g = makeIdleGuard(undefined);
    // Ten quiet-but-just-under-timeout gaps in a row (a slow generation).
    for (let i = 0; i < 10; i++) {
      g.bump();
      vi.advanceTimersByTime(LLM_IDLE_TIMEOUT_MS - 1000);
      expect(g.signal.aborted).toBe(false);
    }
    g.dispose();
  });

  it('forwards a user Stop and marks it NOT a timeout (so the caller propagates it)', () => {
    vi.useFakeTimers();
    const user = new AbortController();
    const g = makeIdleGuard(user.signal);
    g.bump();
    user.abort(new DOMException('stop', 'AbortError'));
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(false); // a Stop, not an idle timeout
    g.dispose();
  });

  it('dispose() clears the timer so it never fires afterwards', () => {
    vi.useFakeTimers();
    const g = makeIdleGuard(undefined);
    g.bump();
    g.dispose();
    vi.advanceTimersByTime(LLM_IDLE_TIMEOUT_MS * 2);
    expect(g.signal.aborted).toBe(false);
  });

  it('an already-aborted user signal aborts the guard immediately', () => {
    const user = new AbortController();
    user.abort(new DOMException('stop', 'AbortError'));
    const g = makeIdleGuard(user.signal);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(false);
    g.dispose();
  });
});
