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
    toolChoice?: unknown;
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
      tool_choice?: unknown;
    };
    completeCalls.push({
      messages: body.messages,
      tools: body.tools,
      toolChoice: body.tool_choice,
      stream: o.stream,
    });
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
    const r = await runScenario({
      mode: 'plan',
      responses: [toolMsg('submit_plan', { goal: 'G', steps: ['一'] })],
      requestPlanDecision: async () => ({ decision: 'reject' as const }),
    });
    const sys = r.completeCalls[0]!.messages[0]!;
    expect(sys.role).toBe('system');
    expect(String(sys.content)).toContain('规划模式');
    expect(r.completeCalls[0]!.tools.some((t) => t.function.name === 'submit_plan')).toBe(true);
    expect(r.doneReason).toBe('no_more_commands'); // user canceled the proposed plan
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

  it('steering: a steer landing on the FINAL (text) turn is still answered + persisted', async () => {
    // The steer is NOT pending at iter-0's top drain — it arrives during the
    // model's first (would-be-final) text turn. Pre-fix the loop exited at the
    // `no_more_commands` return without re-draining, so the steer was dropped
    // and gone on reload (the reported bug). drainSteers() now runs before every
    // finish → one more turn instead of a silent drop. §10.14
    let calls = 0;
    const r = await runScenario({
      responses: [textMsg('初步答复'), textMsg('已按要求修正')],
      takeSteerMessages: () => {
        calls++;
        // call #1 = iter-0 top drain (nothing yet); call #2 = the pre-finish
        // drain at the end of iter 0, where the steer has now landed.
        return calls === 2 ? ['只列前 3 条'] : [];
      },
    });
    // The steer forced a second model turn instead of finishing on the first.
    expect(r.completeCalls).toHaveLength(2);
    // …it was folded into that next turn's context…
    expect(
      r.completeCalls[1]!.messages.some((m) => m.role === 'user' && m.content === '只列前 3 条'),
    ).toBe(true);
    // …and persisted to history, so it survives reopening the session.
    expect(r.session.history.some((t) => t.role === 'user' && t.text === '只列前 3 条')).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('emits per-run metrics on finish', async () => {
    // Just assert the run completes cleanly with a tool turn (metrics are logged,
    // not emitted; this guards the metrics wiring doesn't throw).
    const r = await runScenario({ responses: [toolMsg('generic__x'), textMsg('ok')] });
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: even a "simple" plan still goes through the approval card', async () => {
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    const r = await runScenario({
      mode: 'plan',
      responses: [
        toolMsg('submit_plan', { goal: '打开首页', steps: ['打开小红书首页'], simple: true }),
        textMsg('已打开'),
      ],
      requestPlanDecision: decide,
    });
    // §10.16: the model's self-judged "simple" no longer bypasses the user's
    // explicit 先计划再执行 choice — the approval card always shows.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(r.session.plan?.approved).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: answering without a plan is nudged into submit_plan (§10.16)', async () => {
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    const r = await runScenario({
      mode: 'plan',
      responses: [
        textMsg('这个不用计划,我直接说……'), // bare answer in planning → gets nudged
        toolMsg('submit_plan', { goal: 'G', steps: ['一', '二'] }), // model then submits
        textMsg('开始执行'),
      ],
      requestPlanDecision: decide,
    });
    expect(decide).toHaveBeenCalledTimes(1); // the nudge produced a confirmable plan
    expect(r.session.plan?.steps.map((s) => s.title)).toEqual(['一', '二']);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: gives up nudging and lets the answer through instead of erroring (§10.17)', async () => {
    // A model that refuses to plan (only ever answers) must not loop to an
    // error — after MAX_PLAN_NUDGES it falls through to the answer.
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    const r = await runScenario({
      mode: 'plan',
      responses: [textMsg('我就直接答,不计划')], // always answers, never submits a plan
      requestPlanDecision: decide,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(r.doneReason).toBe('no_more_commands'); // graceful, not 'error'
    expect(r.notices.some((t) => /未提交可确认的计划/.test(t))).toBe(true);
  });

  it('mid-run re-plan: an interjection asking for a plan re-enters the approval gate (§10.16)', async () => {
    const decide = vi.fn(async () => ({ decision: 'approve' as const }));
    let steered = false;
    const r = await runScenario({
      mode: 'chat',
      responses: [
        toolMsg('submit_plan', { goal: '新计划', steps: ['甲', '乙'] }), // the re-plan submits
        textMsg('按新计划做完了'),
      ],
      takeSteerMessages: () => {
        if (steered) return [];
        steered = true;
        return ['先给我一个计划确认一下'];
      },
      requestPlanDecision: decide,
    });
    expect(decide).toHaveBeenCalledTimes(1); // the interjection produced a confirmable plan
    expect(r.session.plan?.steps.map((s) => s.title)).toEqual(['甲', '乙']);
    expect(r.notices.some((t) => /重新规划/.test(t))).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan mode: reflects once before finishing (reflect/re-plan)', async () => {
    const r = await runScenario({
      mode: 'plan',
      responses: [
        toolMsg('submit_plan', { goal: 'G', steps: ['a'] }),
        textMsg('做完了'), // tries to finish with a step still pending → reconcile fires
        textMsg('最终答复'),
      ],
      requestPlanDecision: async () => ({ decision: 'approve' as const }),
    });
    expect(r.completeCalls).toHaveLength(3); // plan + finish-attempt + forced reconcile
    expect(r.notices.some((t) => /对账|自检|收尾/.test(t))).toBe(true);
    expect(r.doneReason).toBe('no_more_commands');
  });

  it('plan reconcile: finishing with unsettled steps forces a truthful update_plan', async () => {
    // Model tries to wrap up with steps still pending. The engine must force ONE
    // update_plan so the checklist is settled HONESTLY (completed/skipped/failed),
    // never auto-stamped all-done and never left at a misleading 0/N. §10.15
    const r = await runScenario({
      mode: 'plan',
      responses: [
        toolMsg('submit_plan', { goal: 'G', steps: ['一', '二'], simple: true }), // auto-approve, seeds pending
        textMsg('差不多了'), // first finish attempt → triggers [对账]
        toolMsg('update_plan', {
          steps: [
            { title: '一', status: 'completed' },
            { title: '二', status: 'skipped', activeForm: '前置条件不满足,跳过' },
          ],
        }), // the forced reconcile turn settles each step truthfully
        textMsg('最终答复'),
      ],
    });
    expect(r.notices.some((t) => /对账/.test(t))).toBe(true);
    // truthful end state preserved — 一 done, 二 skipped — NOT faked as all-complete
    const byTitle = Object.fromEntries(r.session.plan!.steps.map((s) => [s.title, s.status]));
    expect(byTitle['一']).toBe('completed');
    expect(byTitle['二']).toBe('skipped');
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
