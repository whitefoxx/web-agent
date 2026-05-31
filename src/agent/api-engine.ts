/**
 * API engine — drives a session via an OpenAI-compatible chat-completions
 * endpoint with native function-calling.
 *
 * No chatbot tab needed: tool calls are native `tool_calls`, executed through
 * the shared dispatcher (ctx.executeTool), which resolves its own per-site
 * tabs, paces calls, and gates writes. Emits the standard OrchEvent UI stream
 * (assistant_turn + tool_trace + session_done) to the SidePanel.
 *
 * The running OpenAI message array is persisted on the session
 * (`session.apiMessages`) so follow-up turns keep full native context
 * (assistant tool_calls paired 1:1 with tool results).
 *
 * Pre-history: a sibling connector engine (chatbot-tab hijack, text-based
 * `<agent-command>` protocol) used to live in orchestrator.ts. It was
 * removed when the "zero API key" mode was dropped.
 */

import { openAiToolsFromRegistry } from '../tools/manifest';
import { systemPromptApi } from './api-system-prompt';
import { loadLlmConfig } from '../config/llm-config';
import { appendTurn, saveSession } from './session';
import type { AgentEngine, EngineContext, SessionDoneReason } from './engine';
import type { ApiMessage, ToolCall } from './api-types';
import { log, warn, error as logError } from '../runtime/log';

const DEFAULT_MAX_ITERATIONS = 12;
const MAX_TOOL_RESULT_CHARS = 64_000;

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated ${s.length - max} chars]`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

async function chatCompletion(opts: {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ChatCompletionResponse> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
  log('api', `→ POST ${url}`, {
    model: opts.body.model,
    messages: (opts.body.messages as unknown[])?.length,
    tools: (opts.body.tools as unknown[])?.length,
  });
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const text = await resp.text();
    logError('api', `← ${resp.status} (${elapsed}ms)`, { body: text.slice(0, 1000) });
    throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json = (await resp.json()) as ChatCompletionResponse;
  log('api', `← 200 (${elapsed}ms)`, {
    finish: json.choices?.[0]?.finish_reason,
    textLen: json.choices?.[0]?.message?.content?.length ?? 0,
    thinkingLen: json.choices?.[0]?.message?.reasoning_content?.length ?? 0,
    toolCalls: json.choices?.[0]?.message?.tool_calls?.length ?? 0,
    usage: json.usage,
  });
  return json;
}

export const apiEngine: AgentEngine = {
  kind: 'api',

  async run(ctx: EngineContext): Promise<void> {
    const { session } = ctx;

    function finish(reason: SessionDoneReason, err?: string): void {
      session.status = reason === 'error' ? 'error' : reason === 'user_abort' ? 'aborted' : 'idle';
      void saveSession(session);
      ctx.emit({ type: 'session_done', reason, error: err });
      log('api', `session=${session.id} done`, { reason, err });
    }

    const cfg = await loadLlmConfig();
    if (!cfg.apiKey) {
      finish('error', '未配置 API Key。请在设置里填入 API Key 后再试。');
      return;
    }
    if (!cfg.baseUrl) {
      finish('error', '未配置 Base URL。请在设置里选择 provider 或填入自定义 Base URL。');
      return;
    }

    session.status = 'running';
    session.iterations = 0;

    const maxIter = DEFAULT_MAX_ITERATIONS;

    // Persist the user turn for the history drawer, and seed the OpenAI message
    // array (continuing prior turns if any).
    appendTurn(session, { role: 'user', text: ctx.userText, ts: Date.now() });
    const messages: ApiMessage[] = [
      ...(session.apiMessages ?? []),
      { role: 'user', content: ctx.userText },
    ];
    await saveSession(session);

    log('api', `session=${session.id} run() begin`, {
      userText: ctx.userText.slice(0, 80),
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      historyLen: messages.length,
    });

    // Re-pull tools each iteration so a market install mid-conversation shows
    // up on the very next LLM call (no need to start a new session). Cheap —
    // building the schema array is sub-millisecond — and avoids stale tools
    // that the LLM has been told it can call but the registry no longer holds.
    // Track the registry version we last reported, so a one-liner log only
    // fires when the set actually changed.
    let lastToolsCount = -1;

    try {
      for (let iter = 0; iter < maxIter; iter++) {
        if (ctx.signal.aborted) return finish('user_abort');
        session.iterations = iter;
        const iterationId = `${session.id}__api${iter}`;

        ctx.emit({ type: 'iteration_progress', iteration: iter, iterationId, phase: 'awaiting' });

        const tools = openAiToolsFromRegistry();
        if (tools.length !== lastToolsCount) {
          log(
            'api',
            `tools refreshed: ${tools.length} available (was ${lastToolsCount === -1 ? 'initial' : lastToolsCount})`,
          );
          lastToolsCount = tools.length;
        }

        let resp: ChatCompletionResponse;
        try {
          resp = await chatCompletion({
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            signal: ctx.signal,
            body: {
              model: cfg.model,
              messages: [{ role: 'system', content: systemPromptApi() }, ...messages],
              tools,
              tool_choice: 'auto',
              max_tokens: 4096,
            },
          });
        } catch (e) {
          if (ctx.signal.aborted) return finish('user_abort');
          logError('api', 'chatCompletion failed', e);
          return finish('error', e instanceof Error ? e.message : String(e));
        }

        const choice = resp.choices?.[0];
        if (!choice) return finish('error', 'LLM 没有返回任何 choices');
        const msg = choice.message;
        const text = msg.content ?? '';
        const thinking = msg.reasoning_content ?? undefined;
        const toolCalls = msg.tool_calls;

        // Echo the assistant message back into history (incl. reasoning_content
        // — required by some providers' thinking mode on subsequent requests).
        messages.push({
          role: 'assistant',
          content: msg.content ?? '',
          ...(thinking ? { reasoning_content: thinking } : {}),
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        });

        appendTurn(session, {
          role: 'assistant',
          cleanedText: text,
          reasoningText: thinking,
          commands: [],
          iteration: iter,
          ts: Date.now(),
        });
        ctx.emit({
          type: 'assistant_turn',
          iteration: iter,
          cleanedText: text,
          reasoningText: thinking,
          commands: [],
        });
        ctx.emit({ type: 'iteration_progress', iteration: iter, iterationId, phase: 'completed' });
        session.apiMessages = messages;
        await saveSession(session);

        if (!toolCalls || toolCalls.length === 0) return finish('no_more_commands');

        for (const call of toolCalls) {
          if (ctx.signal.aborted) return finish('user_abort');

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            warn('api', `bad JSON arguments for ${call.function.name}`, {
              arguments: call.function.arguments,
            });
          }

          const traceId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          ctx.emit({
            type: 'tool_trace',
            trace: {
              id: traceId,
              action: 'execute_tool',
              tool: call.function.name,
              args,
              status: 'started',
            },
          });
          appendTurn(session, {
            role: 'tool_trace',
            trace: {
              id: traceId,
              action: 'execute_tool',
              tool: call.function.name,
              args,
              status: 'started',
            },
            ts: Date.now(),
          });

          const r = await ctx.executeTool({ tool: call.function.name, args });
          const resultStr = r.ok
            ? truncate(typeof r.result === 'string' ? r.result : safeStringify(r.result))
            : `错误: ${r.error ?? '(unknown)'}`;

          messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr });

          const traceFinal = {
            id: traceId,
            action: 'execute_tool',
            tool: call.function.name,
            args,
            status: (r.ok ? 'completed' : 'failed') as 'completed' | 'failed',
            result: r.result,
            error: r.error,
            durationMs: r.durationMs,
          };
          ctx.emit({ type: 'tool_trace', trace: traceFinal });
          appendTurn(session, { role: 'tool_trace', trace: traceFinal, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
        }

        if (choice.finish_reason !== 'tool_calls') return finish('no_more_commands');
      }
      return finish('max_iterations');
    } finally {
      session.apiMessages = messages;
      await saveSession(session);
    }
  },
};
