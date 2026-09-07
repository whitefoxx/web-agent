/**
 * The single-turn LLM client used by the API engine, built on the Vercel AI
 * SDK. One call in, one parsed response out (OpenAI-compatible shape, so the
 * engine's loop is unchanged), with bounded retry for transient faults (429 /
 * 5xx / network blips — never a 4xx, never an abort), an idle-stall watchdog,
 * and streamed text via `onText`.
 *
 * The AI SDK owns each provider's wire protocol (dedicated @ai-sdk/* packages
 * for Anthropic/OpenAI/DeepSeek/Google/xAI/Groq, openai-compatible for the
 * rest — see src/config/model.ts). This file converts the engine's OpenAI-shaped
 * messages/tools to AI SDK inputs and converts the result back. It does NOT run
 * a tool loop: tools are passed without `execute`, so tool calls come back for
 * the engine to dispatch itself.
 */

import { streamText, tool, jsonSchema, type ModelMessage, type ToolSet } from 'ai';
import { log, warn, error as logError } from '@base/runtime/log';
import { toLanguageModel } from '../config/model';
import {
  DEFAULT_RETRY_POLICY,
  isRetriableNetworkError,
  isRetriableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleep,
  type RetryPolicy,
} from './resilience';
import type { ApiMessage, ContentPart, ToolCall } from './api-types';

export interface ChatCompletionResponse {
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

/** No stream part for this long ⇒ treat the endpoint as a stalled socket and
 * abort (F-34 hang class). Deliberately generous so a slow or SILENTLY-REASONING
 * generation — which can go minutes between signs of life — is never killed;
 * only a truly dead connection is. Reset on every stream part. */
export const LLM_IDLE_TIMEOUT_MS = 180_000;

/** Per-attempt idle watchdog. Aborts the request if it stalls for
 * LLM_IDLE_TIMEOUT_MS with no progress; `bump()` resets it on each stream part.
 * Forwards the caller's Stop signal AND removes its own listener/timer on
 * `dispose()` — so a long run doesn't accumulate abort listeners on the
 * long-lived session signal. `timedOut()` lets the caller tell an idle-timeout
 * abort (retriable stall) apart from a user Stop. Exported for unit tests. */
export function makeIdleGuard(userSignal: AbortSignal | undefined): {
  signal: AbortSignal;
  bump: () => void;
  dispose: () => void;
  timedOut: () => boolean;
} {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timed = false;
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timed = true;
      ac.abort(new DOMException('LLM idle timeout', 'AbortError'));
    }, LLM_IDLE_TIMEOUT_MS);
  };
  const onUser = () => ac.abort(userSignal?.reason);
  if (userSignal) {
    if (userSignal.aborted) ac.abort(userSignal.reason);
    else userSignal.addEventListener('abort', onUser, { once: true });
  }
  const dispose = () => {
    if (timer) clearTimeout(timer);
    userSignal?.removeEventListener('abort', onUser);
  };
  return { signal: ac.signal, bump, dispose, timedOut: () => timed };
}

/* ── OpenAI-shaped body → AI SDK inputs ──────────────────────────────────── */

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

function userContentPart(p: ContentPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text };
  // `image` accepts an https URL or a data: URL string; the SDK formats it per
  // provider (Anthropic image block, OpenAI/Google image part, …).
  return { type: 'image', image: p.image_url.url };
}

/** Convert the engine's OpenAI-shaped messages into an AI SDK system string +
 * ModelMessage[]. System messages go to the `instructions` option, never into
 * `messages` (the SDK rejects a system role there). */
function convertMessages(raw: ApiMessage[]): { system?: string; messages: ModelMessage[] } {
  const systemParts: string[] = [];
  const messages: ModelMessage[] = [];
  // A tool result carries only tool_call_id; recover its tool name from the
  // assistant tool_calls so the AI SDK tool-result part can name its tool.
  const toolNameById = new Map<string, string>();
  for (const m of raw) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }
  for (const m of raw) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'user') {
      messages.push({
        role: 'user',
        content:
          typeof m.content === 'string' ? m.content : (m.content.map(userContentPart) as never),
      });
    } else if (m.role === 'assistant') {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      }
      // reasoning_content is intentionally NOT replayed — providers like DeepSeek
      // explicitly reject it on input.
      messages.push({
        role: 'assistant',
        content: (parts.length ? parts : m.content || '') as never,
      });
    } else {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id,
            toolName: toolNameById.get(m.tool_call_id) ?? 'tool',
            output: { type: 'text', value: m.content },
          },
        ] as never,
      });
    }
  }
  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages };
}

interface OpenAiTool {
  function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
}

/** OpenAI function tools → AI SDK tools with NO execute, so the model's tool
 * calls come back for the engine's own dispatch loop. */
function convertTools(rawTools: unknown): ToolSet | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const t of rawTools as OpenAiTool[]) {
    const fn = t?.function;
    if (!fn?.name) continue;
    set[fn.name] = tool({
      description: fn.description ?? '',
      inputSchema: jsonSchema((fn.parameters ?? { type: 'object', properties: {} }) as never),
    });
  }
  return Object.keys(set).length ? set : undefined;
}

function toOpenAiToolCalls(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>,
): ToolCall[] | undefined {
  if (!calls.length) return undefined;
  return calls.map((c) => ({
    id: c.toolCallId,
    type: 'function' as const,
    function: {
      name: c.toolName,
      arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}),
    },
  }));
}

/** AI SDK finish reason → OpenAI finish_reason. */
function toOpenAiFinish(reason: string, hasToolCalls: boolean): string {
  if (reason === 'tool-calls' || hasToolCalls) return 'tool_calls';
  if (reason === 'length') return 'length';
  return 'stop';
}

/** HTTP status of an AI SDK APICallError, if any (for the retriable check). */
function statusOf(e: unknown): number | undefined {
  const s = (e as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' ? s : undefined;
}

function retryAfterOf(e: unknown): number | undefined {
  const headers = (e as { responseHeaders?: Record<string, string> })?.responseHeaders;
  return headers ? parseRetryAfter(headers['retry-after'] ?? null) : undefined;
}

export async function chatCompletion(opts: {
  apiKey: string;
  baseUrl: string;
  /** Provider preset id — selects the AI SDK package. Absent = openai-compatible
   * (base URL based), preserving pre-migration behavior for callers that don't
   * thread it. */
  provider?: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** Bounded-retry policy for transient faults; defaults to DEFAULT_RETRY_POLICY. */
  policy?: RetryPolicy;
  /** Stream the response and call onText with the growing content. */
  stream?: boolean;
  onText?: (text: string) => void;
}): Promise<ChatCompletionResponse> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const body = opts.body;
  const modelId = typeof body.model === 'string' ? body.model : '';
  const model = toLanguageModel({
    provider: opts.provider ?? 'custom',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: modelId,
  });
  const { system, messages } = convertMessages((body.messages as ApiMessage[]) ?? []);
  const tools = convertTools(body.tools);
  const maxOutputTokens = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  log('api', `→ ${opts.provider ?? 'openai-compat'} ${modelId}`, {
    messages: messages.length,
    tools: tools ? Object.keys(tools).length : 0,
    stream: !!opts.stream,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const isLast = attempt === policy.maxAttempts - 1;
    const t0 = Date.now();
    const guard = makeIdleGuard(opts.signal);
    let streamErr: unknown = null;
    try {
      guard.bump();
      const result = streamText({
        model,
        ...(system ? { instructions: [{ role: 'system', content: system }] } : {}),
        messages,
        ...(tools ? { tools, toolChoice: 'auto' } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        abortSignal: guard.signal,
        maxRetries: 0, // this loop owns retry, to keep the existing policy exact
        onError: ({ error }) => {
          streamErr ??= error;
        },
      });

      let text = '';
      let reasoning = '';
      for await (const part of result.fullStream) {
        guard.bump(); // progress — the stream is alive, reset the watchdog
        if (part.type === 'text-delta') {
          text += part.text;
          if (opts.stream && opts.onText) opts.onText(text);
        } else if (part.type === 'reasoning-delta') {
          reasoning += part.text;
        } else if (part.type === 'error') {
          streamErr ??= part.error;
        }
      }
      if (streamErr) throw streamErr;

      const [finishReason, usage, toolCalls] = await Promise.all([
        result.finishReason,
        result.usage,
        result.toolCalls,
      ]);
      const calls = toOpenAiToolCalls(toolCalls);
      const elapsed = Date.now() - t0;
      log('api', `← ok (${elapsed}ms)${attempt > 0 ? ' (after retry)' : ''}`, {
        finish: finishReason,
        textLen: text.length,
        thinkingLen: reasoning.length,
        toolCalls: calls?.length ?? 0,
        usage,
      });
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: text || null,
              reasoning_content: reasoning || null,
              tool_calls: calls,
            },
            finish_reason: toOpenAiFinish(finishReason, !!calls?.length),
          },
        ],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
      };
    } catch (e) {
      // Idle-timeout stall (NOT a user Stop): connected then went silent past the
      // watchdog. Retry like a transient network fault (§10.27).
      if (guard.timedOut() && !opts.signal?.aborted) {
        lastErr = new Error(`LLM request stalled and timed out (${LLM_IDLE_TIMEOUT_MS / 1000}s with no response)`);
        if (!isLast) {
          const delay = retryDelayMs(attempt, policy);
          warn('api', `stall timeout — attempt ${attempt + 1}/${policy.maxAttempts}, retrying in ${delay}ms`);
          await sleep(delay, opts.signal);
          continue;
        }
        throw lastErr;
      }
      // Stop pressed → propagate at once, never retry.
      if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
      lastErr = e;
      const status = statusOf(e);
      const retriable = status != null ? isRetriableStatus(status) : isRetriableNetworkError(e);
      if (retriable && !isLast) {
        const delay = retryDelayMs(attempt, policy, retryAfterOf(e));
        warn(
          'api',
          `${status ?? 'network'} error — attempt ${attempt + 1}/${policy.maxAttempts}, retrying in ${delay}ms`,
          {
            err: e instanceof Error ? e.message : String(e),
          },
        );
        await sleep(delay, opts.signal);
        continue;
      }
      logError('api', `LLM request failed`, { err: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      guard.dispose();
    }
  }
  throw lastErr ?? new Error('chatCompletion: retries exhausted');
}
