/**
 * Engine-level integration / scenario tests (R1 + R6). Drives the real
 * `runApiSession` loop with a fake LLM (scripted completions) and a fake
 * dispatcher, with session-store mocked to a no-op (no IndexedDB in node). The
 * `runScenario` helper IS the scenario-eval framework — golden multi-turn flows
 * asserting the harness's key behaviours. docs/agent-harness.md §10.13.
 */
import { describe, expect, it, vi } from 'vitest';

// saveSession() → putSession() hits IndexedDB; stub it so the loop runs in node.
vi.mock('../src/agent/session-store', () => ({
  putSession: async () => {},
  getSession: async () => null,
  listSessions: async () => [],
  deleteSessionFromDb: async () => {},
}));

import {
  runApiSession,
  type ApiEngineDeps,
  type ChatCompletionResponse,
} from '../src/agent/api-engine';
import { makeSession } from '../src/agent/session';
import type { EngineContext, OrchEvent } from '../src/agent/engine';
import type { LlmProfile } from '../src/config/llm-config';

const PROFILE: LlmProfile = {
  id: 'p',
  provider: 'openai',
  baseUrl: 'http://x',
  apiKey: 'k',
  model: 'm',
  label: 'test',
};
const SLOTS = { primary: PROFILE, vision: null, image: null };

function textMsg(text: string): ChatCompletionResponse {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
}
let cid = 0;
function toolMsg(name: string, args: Record<string, unknown> = {}): ChatCompletionResponse {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `c${cid++}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  };
}

interface ScenarioOpts {
  userText?: string;
  mode?: 'chat' | 'plan';
  responses: ChatCompletionResponse[];
  executeTool?: EngineContext['executeTool'];
  requestPlanDecision?: EngineContext['requestPlanDecision'];
  takeSteerMessages?: EngineContext['takeSteerMessages'];
  budget?: ApiEngineDeps['budget'];
}

async function runScenario(opts: ScenarioOpts) {
  const events: OrchEvent[] = [];
  const completeCalls: {
    messages: { role: string; content: unknown }[];
    tools: { function: { name: string } }[];
    stream?: boolean;
  }[] = [];
  const session = makeSession('test');
  let i = 0;
  const ctx: EngineContext = {
    session,
    userText: opts.userText ?? 'hi',
    signal: new AbortController().signal,
    mode: opts.mode,
    emit: (e) => events.push(e),
    executeTool: opts.executeTool ?? (async () => ({ ok: true, result: 'ok', durationMs: 1 })),
    requestPlanDecision:
      opts.requestPlanDecision ?? (async () => ({ decision: 'approve' as const })),
    takeSteerMessages: opts.takeSteerMessages ?? (() => []),
  };
  const complete: ApiEngineDeps['complete'] = async (o) => {
    const body = o.body as {
      messages: (typeof completeCalls)[number]['messages'];
      tools: (typeof completeCalls)[number]['tools'];
    };
    completeCalls.push({ messages: body.messages, tools: body.tools, stream: o.stream });
    return opts.responses[Math.min(i++, opts.responses.length - 1)]!;
  };
  await runApiSession(ctx, { complete, slots: SLOTS, budget: opts.budget });
  const done = events.find((e) => e.type === 'session_done') as { reason?: string } | undefined;
  const notices = events
    .filter((e) => e.type === 'notice')
    .map((e) => (e as { text: string }).text);
  return { events, completeCalls, session, doneReason: done?.reason, notices };
}

describe('runApiSession — engine integration scenarios', () => {
  it('chat: answers directly and finishes', async () => {
    const r = await runScenario({ responses: [textMsg('你好')] });
    expect(r.doneReason).toBe('no_more_commands');
    const turn = r.events.find((e) => e.type === 'assistant_turn') as { cleanedText: string };
    expect(turn.cleanedText).toBe('你好');
  });

  it('chat: executes a tool then finishes', async () => {
    const exec = vi.fn(async () => ({ ok: true, result: 'page text', durationMs: 1 }));
    const r = await runScenario({
      responses: [toolMsg('generic__get_page_text'), textMsg('总结')],
      executeTool: exec,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0].tool).toBe('generic__get_page_text');
    expect(r.doneReason).toBe('no_more_commands');
    expect(r.completeCalls).toHaveLength(2);
  });

  it('breaks out of a repeated failing tool (thrash) → checkpoint', async () => {
    const exec = vi.fn(async () => ({ ok: false, error: 'nope', durationMs: 1 }));
    const r = await runScenario({ responses: [toolMsg('x__bad', { q: 1 })], executeTool: exec });
    expect(exec).toHaveBeenCalledTimes(3); // DEFAULT_THRASH.maxSameFailure
    expect(r.doneReason).toBe('checkpoint');
    expect(r.notices.some((t) => /熔断/.test(t))).toBe(true);
  });

  it('checkpoints when the step budget is exhausted', async () => {
    const r = await runScenario({
      responses: [toolMsg('generic__open_url', { u: 'x' })],
      budget: { maxSteps: 2, softTokenLimit: 1e9, hardTokenLimit: 1e9 },
    });
    expect(r.completeCalls).toHaveLength(2);
    expect(r.doneReason).toBe('checkpoint');
    expect(r.notices.some((t) => /步数上限/.test(t))).toBe(true);
  });

  it('plan mode: research → propose → approve → execute', async () => {
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    const r = await runScenario({
      mode: 'plan',
      responses: [toolMsg('submit_plan', { goal: '搞定', steps: ['一', '二'] }), textMsg('完成')],
      requestPlanDecision: decide,
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(r.session.plan?.approved).toBe(true);
    expect(r.session.plan?.steps.map((s) => s.title)).toEqual(['一', '二']);
    expect(r.events.some((e) => e.type === 'plan_updated')).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: a rejected plan cancels without executing', async () => {
    const r = await runScenario({
      mode: 'plan',
      responses: [toolMsg('submit_plan', { goal: 'g', steps: ['a'] })],
      requestPlanDecision: async () => ({ decision: 'reject' as const }),
    });
    expect(r.completeCalls).toHaveLength(1); // no execution turn
    expect(r.doneReason).toBe('no_more_commands');
    expect(r.notices.some((t) => /取消/.test(t))).toBe(true);
  });

  it('plan mode uses the read-only planning prompt + submit_plan tool', async () => {
    const r = await runScenario({ mode: 'plan', responses: [textMsg('简单任务,直接答')] });
    const sys = r.completeCalls[0]!.messages[0]!;
    expect(sys.role).toBe('system');
    expect(String(sys.content)).toContain('规划模式');
    expect(r.completeCalls[0]!.tools.some((t) => t.function.name === 'submit_plan')).toBe(true);
    expect(r.doneReason).toBe('no_more_commands'); // answered directly, no plan needed
  });

  it('spawn_subagent: runs isolated and returns only a digest', async () => {
    const r = await runScenario({
      responses: [
        toolMsg('spawn_subagent', { task: '抓取对比' }),
        textMsg('子digest'),
        textMsg('最终'),
      ],
    });
    expect(r.completeCalls).toHaveLength(3); // main + subagent + main
    expect(r.notices.some((t) => /子 agent 完成/.test(t))).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('steering: a mid-run injected message reaches the very next turn', async () => {
    let steered = false;
    const r = await runScenario({
      responses: [toolMsg('generic__x'), textMsg('done')],
      takeSteerMessages: () => {
        if (steered) return [];
        steered = true;
        return ['请改成只看前 3 条'];
      },
    });
    const firstMsgs = r.completeCalls[0]!.messages;
    expect(firstMsgs.some((m) => m.role === 'user' && m.content === '请改成只看前 3 条')).toBe(
      true,
    );
  });

  it('emits per-run metrics on finish', async () => {
    // Just assert the run completes cleanly with a tool turn (metrics are logged,
    // not emitted; this guards the metrics wiring doesn't throw).
    const r = await runScenario({ responses: [toolMsg('generic__x'), textMsg('ok')] });
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: simple=true auto-proceeds without the approval gate', async () => {
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    const r = await runScenario({
      mode: 'plan',
      responses: [
        toolMsg('submit_plan', { goal: '打开首页', steps: ['打开小红书首页'], simple: true }),
        textMsg('已打开'),
      ],
      requestPlanDecision: decide,
    });
    expect(decide).not.toHaveBeenCalled(); // no approval popup for a simple task
    expect(r.session.plan?.approved).toBe(true);
    expect(r.notices.some((t) => /直接开始/.test(t))).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: reflects once before finishing (reflect/re-plan)', async () => {
    const r = await runScenario({
      mode: 'plan',
      responses: [
        toolMsg('submit_plan', { goal: 'G', steps: ['a'] }),
        textMsg('做完了'), // tries to finish with the step still pending → reflection fires
        textMsg('最终答复'),
      ],
      requestPlanDecision: async () => ({ decision: 'approve' as const }),
    });
    expect(r.completeCalls).toHaveLength(3); // plan + finish-attempt + post-reflection
    expect(r.notices.some((t) => /自检|收尾/.test(t))).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('emits live run_stats with step + token usage', async () => {
    const r = await runScenario({ responses: [toolMsg('generic__x'), textMsg('ok')] });
    const stats = r.events.filter((e) => e.type === 'run_stats') as {
      step: number;
      promptTokens: number;
    }[];
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]!.step).toBe(1);
    expect(stats[0]!.promptTokens).toBe(10);
  });
});
