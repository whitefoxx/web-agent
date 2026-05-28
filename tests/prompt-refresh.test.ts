/**
 * Verify the continuation-mode prompt refresh logic: every Nth follow-up
 * user turn re-injects the full first-turn system prompt; the in-between
 * turns just append a short reminder. This stops DeepSeek (or any chatbot)
 * from drifting back to "use my own knowledge / built-in search" after
 * many follow-up turns.
 */

import { describe, it, expect } from 'vitest';
import { runSession, type Driver } from '../src/agent/orchestrator';
import { makeSession } from '../src/agent/session';
import { buildContinuationReminder } from '../src/agent/system-prompt';

// Side-effect: register adapters so the system prompt has tools to list.
import '../src/tools/xiaohongshu/_all';

function stubDriver(): { driver: Driver; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    driver: {
      async inject({ text }) {
        prompts.push(text);
      },
      async waitForResponse() {
        // Immediately return an empty (no-command) response so each
        // runSession finishes after one iteration.
        return { rawText: '', cleanedText: 'ok', commands: [] };
      },
      async executeTool() {
        return { ok: true, durationMs: 0 };
      },
      emit() {},
    },
  };
}

describe('buildContinuationReminder', () => {
  it('keeps userText verbatim and appends a short anchor line', () => {
    const out = buildContinuationReminder('看下小红书首页');
    expect(out.startsWith('看下小红书首页')).toBe(true);
    expect(out).toMatch(/agent-command/);
    expect(out).toMatch(/list_tools|describe_tool|execute_tool/);
    // Should be short — not a full reprint of the protocol.
    expect(out.length).toBeLessThan(400);
  });

  it('trims excessive surrounding whitespace in userText', () => {
    const out = buildContinuationReminder('   hello\n\n');
    expect(out.startsWith('hello')).toBe(true);
  });
});

describe('orchestrator continuation prompt refresh', () => {
  // The full first-turn prompt has the tool-first core-principles section
  // and the tool-call protocol section. The continuation reminder has
  // neither — it just appends a one-line anchor after userText. Use the
  // "核心原则" heading as the fingerprint for distinguishing.
  const FULL_PROMPT_FINGERPRINT = '核心原则';

  it('first turn always sends the full first-turn prompt', async () => {
    const stub = stubDriver();
    const s = makeSession('refresh-1');
    await runSession({ session: s, userText: 'q1', driver: stub.driver, continuation: false });
    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toContain(FULL_PROMPT_FINGERPRINT);
    expect(stub.prompts[0]).toContain('WebChat Agent');
    expect(stub.prompts[0]).toContain('q1');
    expect(s.turnsSinceFullPrompt).toBe(0);
  });

  it('continuation turns send the reminder until the refresh threshold', async () => {
    const s = makeSession('refresh-2');
    // Pretend the first turn already happened.
    s.turnsSinceFullPrompt = 0;
    for (let i = 1; i <= 6; i++) {
      const stub = stubDriver();
      await runSession({
        session: s,
        userText: `follow ${i}`,
        driver: stub.driver,
        continuation: true,
      });
      const sent = stub.prompts[0];
      if (i <= 5) {
        // Turns 1..5 → just the reminder, no full judgment guide.
        expect(sent, `turn ${i} should be reminder-only`).not.toContain(FULL_PROMPT_FINGERPRINT);
        expect(sent).toContain('WebChat Agent 提醒');
        expect(sent).toContain(`follow ${i}`);
      } else {
        // Turn 6 → re-anchor with full prompt.
        expect(sent, `turn ${i} should re-anchor`).toContain(FULL_PROMPT_FINGERPRINT);
        expect(sent).toContain(`follow ${i}`);
      }
    }
    // After the re-anchor on turn 6, counter was reset to 0.
    expect(s.turnsSinceFullPrompt).toBe(0);
  });

  it('reminder is significantly shorter than the full first-turn prompt', async () => {
    const stubA = stubDriver();
    const stubB = stubDriver();
    const a = makeSession('size-a');
    const b = makeSession('size-b');
    await runSession({ session: a, userText: 'q', driver: stubA.driver, continuation: false });
    await runSession({ session: b, userText: 'q', driver: stubB.driver, continuation: true });
    expect(stubB.prompts[0].length).toBeLessThan(stubA.prompts[0].length / 3);
  });
});
