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
import type { ApiMessage, ContentPart, ToolCall } from './api-types';
import { collectImageRefs, stripDataUrls, isDataUrl } from './tool-images';
import { log, warn, error as logError } from '../runtime/log';

const DEFAULT_MAX_ITERATIONS = 12;
const MAX_TOOL_RESULT_CHARS = 64_000;
/** Cap images fed to the model per turn (vision tokens are expensive, and a
 * turn with several image-returning tools could otherwise balloon). */
const MAX_VISION_IMAGES_PER_TURN = 8;

/** Model-driven vision: a pseudo-tool offered only to vision-capable profiles.
 * Tool results keep image URLs in their TEXT (as data); when the model decides
 * the task needs it to actually SEE an image, it calls this with the relevant
 * URLs. The engine intercepts the call (it doesn't go through the dispatcher),
 * validates the URLs, and injects them as a vision user message. This is the
 * "the LLM decides which images + intent" step, expressed as native function
 * calling instead of an intent-blind auto-scan. */
const VIEW_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'view_image',
    description:
      '查看一张或多张图片的实际内容（视觉理解）。**仅当你需要分析/理解图片内容时**才调用：例如用户让你“看看这张图是什么”，或需要根据图片内容来回答。传入要查看的图片完整 http(s) 地址。注意：如果图片地址只是要传递的数据（例如用户让你把某图片链接发到评论里、或保存某链接），**不要**调用本工具——直接把 URL 当文本用即可。不要凭 URL 猜测图片内容；真正要看图才调用。',
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '要查看的图片 URL 列表（完整 http/https 地址）',
        },
        purpose: { type: 'string', description: '可选：为什么要看这些图（便于记录）' },
      },
      required: ['images'],
    },
  },
};

/** Appended to the system prompt for vision profiles so the model knows the
 * view_image affordance exists (otherwise it won't reliably call it). */
const VISION_SYSTEM_NOTE = `

## 看图能力
当前模型支持视觉,但你默认看不到图像本身——无论是用户在消息里给的图片地址,还是工具结果里的图片链接,对你来说都只是 URL 文本。
- 当你**需要分析/理解图片内容**时(例如用户让你“看看这张图是什么”、或需要依据图片内容作答),调用 view_image 工具,传入要查看的图片完整 URL。
- 如果图片地址只是**要传递的数据**(例如用户让你把某图片链接发到评论里、保存某个链接),**不要**调用 view_image——直接把 URL 当文本用即可。
- 截图类工具(generic__screenshot)的结果会自动作为图像呈现,无需 view_image。`;

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

/** Flatten a multimodal user `content` array down to plain text, for replaying
 * a vision turn's history to a text-only model (which 400s on image content). */
function contentPartsToText(parts: ContentPart[]): string {
  const texts: string[] = [];
  let imgs = 0;
  for (const p of parts) {
    if (p.type === 'text') texts.push(p.text);
    else if (p.type === 'image_url') imgs++;
  }
  let s = texts.join('\n');
  if (imgs) s += `${s ? '\n' : ''}[${imgs} 张图片，当前模型不支持视觉，已省略]`;
  return s || '[图片]';
}

/**
 * Repair a persisted message history before re-sending it:
 *   1. Every assistant message with `tool_calls` must be answered by a tool
 *      message for each id BEFORE any non-tool message — else the API 400s.
 *      An abort mid tool-loop (e.g. during a write-confirm) can leave dangling
 *      ids; pad them with placeholder tool messages.
 *   2. Flatten any PRIOR-turn image-bearing user message (ContentPart[]) down to
 *      text. The model already saw those images live in the turn they were
 *      produced (the active messages array that turn), and its response — kept
 *      in history — carries what it gleaned. Re-sending base64 every subsequent
 *      turn is pure token/bandwidth cost, and replaying images to a since-
 *      switched text-only model would 400. So images live for exactly one turn.
 */
export function sanitizeHistory(history: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === 'user' && Array.isArray(m.content)) {
      out.push({ role: 'user', content: contentPartsToText(m.content) });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push(m);
      const answered = new Set<string>();
      let j = i + 1;
      while (j < history.length && history[j]!.role === 'tool') {
        const tm = history[j] as { role: 'tool'; tool_call_id: string; content: string };
        out.push(tm);
        answered.add(tm.tool_call_id);
        j++;
      }
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          out.push({ role: 'tool', tool_call_id: tc.id, content: '[已中断,无结果]' });
        }
      }
      i = j - 1;
      continue;
    }
    out.push(m);
  }
  return out;
}

/** True if any message has array (multimodal) content with an image part. */
function hasImageContent(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some(
      (m) =>
        m &&
        typeof m === 'object' &&
        Array.isArray((m as { content?: unknown }).content) &&
        ((m as { content: unknown[] }).content).some(
          (p) => p && typeof p === 'object' && (p as { type?: string }).type === 'image_url',
        ),
    )
  );
}

/** Deep-clone a request body for logging, truncating long base64 data URLs so
 * the console stays readable while http image URLs stay fully visible. */
function redactBodyForLog(body: Record<string, unknown>): unknown {
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'url' && typeof value === 'string' && value.startsWith('data:') && value.length > 120) {
        return value.slice(0, 80) + `…[${value.length} chars base64]`;
      }
      // Trim very long tool/text content so the body is scannable.
      if ((key === 'content' || key === 'text') && typeof value === 'string' && value.length > 600) {
        return value.slice(0, 600) + `…[${value.length} chars]`;
      }
      return value;
    }),
  );
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
  // When the request carries image content, dump the FULL request body (with
  // base64 data URLs truncated for readability) so the exact shape sent to the
  // provider can be compared against its docs. Only logs on image turns to keep
  // normal traffic quiet.
  if (hasImageContent(opts.body.messages)) {
    log('api', '→ vision request body', redactBodyForLog(opts.body));
  }
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
    // The user's message stays plain TEXT even if it contains image URLs — it's
    // the model's call (via view_image) whether to actually look at them. A URL
    // the user only wants passed along (e.g. "把这张图发到评论 https://x.jpg")
    // must NOT be force-fed as vision. Fully model-driven; see VISION_SYSTEM_NOTE.
    // sanitizeHistory repairs replayed history (dangling tool_calls, prior-turn
    // image messages flattened to text).
    const messages: ApiMessage[] = [
      ...sanitizeHistory(session.apiMessages ?? []),
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

        // Offer view_image only to vision profiles (a text model can't use it).
        const tools = cfg.vision
          ? [...openAiToolsFromRegistry(), VIEW_IMAGE_TOOL]
          : openAiToolsFromRegistry();
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
              messages: [
                {
                  role: 'system',
                  content: systemPromptApi() + (cfg.vision ? VISION_SYSTEM_NOTE : ''),
                },
                ...messages,
              ],
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

        // Images collected from ALL tool results this turn. Pushed as ONE user
        // message AFTER the loop — interleaving a user message between tool
        // messages would break the "every tool_call_id answered contiguously
        // before the next non-tool message" contract when there are ≥2 calls.
        const turnImages: string[] = [];

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

          // Model-driven vision (view_image): intercepted here — it doesn't go
          // through the dispatcher. Validate the URLs the model asked to see,
          // ack via a text tool message, and queue them for the post-loop image
          // user message. This is the pure-model-driven path for URL images.
          if (call.function.name === 'view_image') {
            const reqUrls = Array.isArray((args as { images?: unknown }).images)
              ? ((args as { images: unknown[] }).images).filter(
                  (u): u is string => typeof u === 'string',
                )
              : [];
            // Trust the model's intent: accept any http(s) URL it asked to see,
            // no image-pattern gating (a strict regex would wrongly reject valid
            // images with unusual hosts/paths — the model decided it's an image).
            const valid = reqUrls
              .filter((u) => /^https?:\/\//i.test(u.trim()))
              .slice(0, MAX_VISION_IMAGES_PER_TURN);
            turnImages.push(...valid);
            const dropped = reqUrls.length - valid.length;
            const ack =
              valid.length > 0
                ? `已接收 ${valid.length} 张图片，将作为图像呈现给你查看${dropped > 0 ? `（${dropped} 个非 http/https 地址已忽略）` : ''}。`
                : '没有可用的图片地址（需为完整 http/https URL）。';
            messages.push({ role: 'tool', tool_call_id: call.id, content: ack });
            const vTrace = {
              id: traceId,
              action: 'execute_tool' as const,
              tool: 'view_image',
              args,
              status: 'completed' as const,
              result: { accepted: valid, ignored: dropped },
              durationMs: 0,
            };
            ctx.emit({ type: 'tool_trace', trace: vTrace });
            appendTurn(session, { role: 'tool_trace', trace: vTrace, ts: Date.now() });
            session.apiMessages = messages;
            await saveSession(session);
            continue;
          }

          const r = await ctx.executeTool({ tool: call.function.name, args });

          // Auto-attach only DATA URLs (screenshots) from a tool result: their
          // base64 can't round-trip through a view_image tool-call argument, so
          // a model can't ask for them by reference. http image URLs are NOT
          // auto-attached — the model requests those via view_image (above).
          // Gated on `vision` so text-only models never get image content.
          const images =
            cfg.vision && r.ok
              ? collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN).filter(isDataUrl)
              : [];

          let rawResult = r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `错误: ${r.error ?? '(unknown)'}`;
          // Strip ALL base64 image data URLs from the TEXT (not just the ones we
          // collected for vision) — they're either sent as vision blocks or
          // dropped, and raw base64 is pure truncation noise either way.
          rawResult = stripDataUrls(rawResult);
          const resultStr = truncate(rawResult);

          messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr });
          if (images.length) turnImages.push(...images);

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

        // One image-bearing user message for the whole turn (after every tool
        // response), so a multimodal model can see the images. Sent as raw URLs
        // (the model's server fetches them — matches GLM's image_url doc).
        // Capped to bound request size when many tools fire at once.
        // NOTE: if a CDN is hotlink-protected and the model can't fetch the URL
        // (e.g. sina → GLM 1210), src/agent/fetch-image.ts (toVisionDataUrl) is
        // ready to inline the bytes as base64 instead — wire it back in here.
        if (turnImages.length) {
          const capped = turnImages.slice(0, MAX_VISION_IMAGES_PER_TURN);
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `（本回合工具结果包含 ${capped.length} 张图片，按顺序如下）` },
              ...capped.map((url) => ({ type: 'image_url', image_url: { url } }) as const),
            ],
          });
          log('api', `vision: attached ${capped.length} image url(s) this turn`, { urls: capped });
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
