/**
 * Orchestrator unit tests — drive the loop with a stub Driver so we can
 * verify routing of list_tools / describe_tool / execute_tool / done
 * actions without spinning up Chrome.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { runSession, type Driver, type OrchEvent } from '../src/agent/orchestrator';
import { makeSession } from '../src/agent/session';
import type { ParsedCommand } from '../src/connectors/messages';

// Side-effect import: register adapters so list_tools / describe_tool have
// something real to talk about.
import '../src/tools/generic/_all';

// chrome.storage isn't available in node tests; the session module just
// silently noops the saveSession call, which is what we want here.

interface StubDriverOptions {
  /** Sequence of responses to return on successive waitForResponse calls. */
  responses: Array<{
    cleanedText: string;
    commands: ParsedCommand[];
  }>;
  /** Optional handler for executeTool. Defaults to ok with `{}`. */
  onExecute?: (tool: string, args: Record<string, unknown>) => unknown;
}

function makeStub(opts: StubDriverOptions): {
  driver: Driver;
  events: OrchEvent[];
  prompts: string[];
} {
  const events: OrchEvent[] = [];
  const prompts: string[] = [];
  let i = 0;
  return {
    events,
    prompts,
    driver: {
      async inject({ text }) {
        prompts.push(text);
      },
      async waitForResponse() {
        const r = opts.responses[i++];
        if (!r) throw new Error('no more stub responses');
        return {
          rawText: r.cleanedText,
          cleanedText: r.cleanedText,
          commands: r.commands,
        };
      },
      async executeTool({ tool, args }) {
        const t0 = Date.now();
        try {
          const result = opts.onExecute ? opts.onExecute(tool, args) : { ok: true };
          return { ok: true, result, durationMs: Date.now() - t0 };
        } catch (e) {
          return {
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - t0,
          };
        }
      },
      emit(e) {
        events.push(e);
      },
    },
  };
}

function cmd(action: string, extra: Partial<ParsedCommand> = {}): ParsedCommand {
  return { action, raw: `(${action})`, ...extra };
}

describe('orchestrator', () => {
  beforeEach(() => {
    // nothing global to reset between tests
  });

  it('finishes immediately when first response has no commands', async () => {
    const stub = makeStub({
      responses: [{ cleanedText: '直接回答你：xxx', commands: [] }],
    });
    const s = makeSession('test1');
    await runSession({ session: s, userText: '你好', driver: stub.driver });
    expect(stub.prompts).toHaveLength(1);
    expect(stub.events.find((e) => e.type === 'session_done')).toMatchObject({
      type: 'session_done',
      reason: 'no_more_commands',
    });
  });

  it('routes list_tools through the meta handler and continues', async () => {
    const stub = makeStub({
      responses: [
        {
          cleanedText: '让我先看看有哪些工具：',
          commands: [cmd('list_tools', { args: { category: 'generic' } })],
        },
        { cleanedText: '好了，现在我能回答了。', commands: [] },
      ],
    });
    const s = makeSession('test2');
    await runSession({ session: s, userText: 'q', driver: stub.driver });
    expect(stub.prompts).toHaveLength(2);
    // Second prompt should contain the list_tools result, including at least one generic tool name.
    expect(stub.prompts[1]).toContain('list_tools');
    expect(stub.prompts[1]).toMatch(/generic__/);
  });

  it('routes describe_tool through the meta handler', async () => {
    const stub = makeStub({
      responses: [
        {
          cleanedText: '需要参数：',
          commands: [cmd('describe_tool', { args: { name: 'generic__open_url' } })],
        },
        { cleanedText: '好。', commands: [] },
      ],
    });
    const s = makeSession('test3');
    await runSession({ session: s, userText: 'q', driver: stub.driver });
    expect(stub.prompts[1]).toMatch(/describe_tool/);
    expect(stub.prompts[1]).toMatch(/generic__open_url/);
  });

  it('routes execute_tool through the driver and forwards result', async () => {
    let captured: { tool: string; args: Record<string, unknown> } | null = null;
    const stub = makeStub({
      responses: [
        {
          cleanedText: '执行：',
          commands: [
            cmd('execute_tool', {
              tool: 'generic__open_url',
              args: { limit: 5 },
            }),
          ],
        },
        { cleanedText: '总结：n 条', commands: [] },
      ],
      onExecute: (tool, args) => {
        captured = { tool, args };
        return [{ rank: 1, title: 'hello' }];
      },
    });
    const s = makeSession('test4');
    await runSession({ session: s, userText: 'q', driver: stub.driver });
    expect(captured).toEqual({ tool: 'generic__open_url', args: { limit: 5 } });
    expect(stub.prompts[1]).toContain('generic__open_url');
    expect(stub.prompts[1]).toContain('hello');
  });

  it('terminates on explicit done action', async () => {
    const stub = makeStub({
      responses: [{ cleanedText: '我准备好了。', commands: [cmd('done')] }],
    });
    const s = makeSession('test5');
    await runSession({ session: s, userText: 'q', driver: stub.driver });
    expect(stub.events.find((e) => e.type === 'session_done')).toMatchObject({
      reason: 'done_signal',
    });
  });

  it('stops at max_iterations to avoid runaway loops', async () => {
    // Provide infinitely-many command turns; cap should kick in.
    const stub = makeStub({
      responses: Array.from({ length: 10 }, () => ({
        cleanedText: '再来一次',
        commands: [cmd('list_tools', { args: { category: 'generic' } })],
      })),
    });
    const s = makeSession('test6');
    await runSession({
      session: s,
      userText: 'q',
      driver: stub.driver,
      maxIterations: 3,
    });
    expect(stub.events.find((e) => e.type === 'session_done')).toMatchObject({
      reason: 'max_iterations',
    });
    expect(stub.prompts).toHaveLength(3);
  });

  it('surfaces tool execution failures into the next prompt', async () => {
    const stub = makeStub({
      responses: [
        {
          cleanedText: '尝试执行：',
          commands: [cmd('execute_tool', { tool: 'no__such', args: {} })],
        },
        { cleanedText: '了解了', commands: [] },
      ],
      onExecute: () => {
        throw new Error('boom');
      },
    });
    const s = makeSession('test7');
    await runSession({ session: s, userText: 'q', driver: stub.driver });
    expect(stub.prompts[1]).toMatch(/工具失败|失败/);
    expect(stub.prompts[1]).toContain('boom');
  });
});
