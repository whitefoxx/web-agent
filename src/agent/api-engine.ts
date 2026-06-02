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
import { resolveSlots, type LlmProfile } from '../config/llm-config';
import { visionDescribe, generateImage } from './specialist';
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

/** Image generation: offered when an `image` slot is configured. The engine
 * intercepts the call and routes it to that slot's model's /images/generations. */
const GENERATE_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description:
      '根据文本描述生成图片。当用户要你“画一张/生成一张图”时调用,返回生成图片的 URL。拿到结果后,用 markdown 图片语法 ![](图片URL) 把图直接展示给用户(会内联渲染成图片),不要只贴纯文本链接。**不要**再用 view_image 去看你自己刚生成的图——那是多余的一次请求,除非用户明确要你检查/分析这张图的内容。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片内容的文本描述(尽量具体)' },
        size: { type: 'string', description: '可选:尺寸,如 1024x1024' },
      },
      required: ['prompt'],
    },
  },
};

/** Build the system-prompt note listing the specialist capabilities configured
 * in this setup, so the orchestrator knows what it can delegate — and can tell
 * the user when a needed capability isn't configured. */
function specialistSystemNote(caps: { vision: boolean; image: boolean }): string {
  const lines: string[] = [];
  if (caps.vision)
    lines.push(
      '- 视觉理解(view_image):需要分析/理解图片内容时调用,传入图片完整 URL。仅在真正要看图时调;若图片地址只是要传递的数据(如发评论带链接),不要调用。',
    );
  if (caps.image)
    lines.push('- 图像生成(generate_image):用户要画图/生成图片时调用,返回图片 URL。');
  const header = '\n\n## 专门能力(多模型协作)';
  if (lines.length === 0) {
    return `${header}\n当前未配置任何专门能力模型(视觉理解 / 图像生成等)。若任务需要这些能力,告诉用户去「设置 → 模型分工」里为对应能力指派一个模型。`;
  }
  return (
    `${header}\n你可调用以下专门能力(它们是工具,会路由到专门配置的模型):\n${lines.join('\n')}\n` +
    '其他能力(如音频 / 视频生成)当前未配置——若任务需要,告知用户去「设置 → 模型分工」添加对应模型。\n' +
    '截图类工具(generic__screenshot)的结果会自动作为图像呈现,无需 view_image。'
  );
}

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

interface SpecialistResult {
  ok: boolean;
  /** The tool message content handed back to the primary (the specialist's
   * answer for a sub-call, or an ack for inline / an error message). */
  toolContent: string;
  /** URLs to inject into the PRIMARY's own context (only the inline-vision
   * case — primary is multimodal); undefined for sub-calls. */
  inlineImages?: string[];
  traceResult?: unknown;
}

/** Route a specialist tool call (view_image / generate_image) to the capability
 * slot's model. view_image is either inline (primary is multimodal → inject) or
 * a sub-call to a separate vision model (→ return its description as text).
 * generate_image always sub-calls the image-gen model. Never throws. */
async function handleSpecialistCall(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    visionProfile: LlmProfile | null;
    visionInline: boolean;
    imageProfile: LlmProfile | null;
    signal?: AbortSignal;
  },
): Promise<SpecialistResult> {
  if (name === 'view_image') {
    const reqUrls = Array.isArray((args as { images?: unknown }).images)
      ? ((args as { images: unknown[] }).images).filter((u): u is string => typeof u === 'string')
      : [];
    // Trust the model's intent: accept any http(s) URL (no image-pattern gating).
    const valid = reqUrls
      .filter((u) => /^https?:\/\//i.test(u.trim()))
      .slice(0, MAX_VISION_IMAGES_PER_TURN);
    if (valid.length === 0) {
      return { ok: false, toolContent: '没有可用的图片地址(需为完整 http/https URL)。' };
    }
    const question = typeof args.purpose === 'string' ? args.purpose : '';
    if (ctx.visionInline) {
      const dropped = reqUrls.length - valid.length;
      return {
        ok: true,
        toolContent: `已接收 ${valid.length} 张图片,将作为图像呈现给你查看${dropped > 0 ? `(${dropped} 个非 http/https 地址已忽略)` : ''}。`,
        inlineImages: valid,
        traceResult: { mode: 'inline', accepted: valid },
      };
    }
    if (!ctx.visionProfile) return { ok: false, toolContent: '未配置视觉模型。' };
    if (!ctx.visionProfile.apiKey || !ctx.visionProfile.baseUrl) {
      return { ok: false, toolContent: '视觉模型未填 API Key 或 Base URL,请在「模型分工」检查。' };
    }
    log('api', `vision subcall → ${ctx.visionProfile.model} (${valid.length} image(s))`, {
      baseUrl: ctx.visionProfile.baseUrl,
    });
    try {
      const desc = await visionDescribe(ctx.visionProfile, valid, question, { signal: ctx.signal });
      log('api', `vision subcall ← ${ctx.visionProfile.model} (${desc.length} chars)`);
      return {
        ok: true,
        toolContent: desc,
        traceResult: { mode: 'subcall', model: ctx.visionProfile.model, images: valid },
      };
    } catch (e) {
      return {
        ok: false,
        toolContent: `视觉模型(${ctx.visionProfile.model})调用失败:${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (name === 'generate_image') {
    if (!ctx.imageProfile) return { ok: false, toolContent: '未配置图像生成模型。' };
    if (!ctx.imageProfile.apiKey || !ctx.imageProfile.baseUrl) {
      return { ok: false, toolContent: '图像生成模型未填 API Key 或 Base URL,请在「模型分工」检查。' };
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return { ok: false, toolContent: 'prompt 不能为空。' };
    const size = typeof args.size === 'string' ? args.size : undefined;
    log('api', `image subcall → ${ctx.imageProfile.model}`, { baseUrl: ctx.imageProfile.baseUrl });
    try {
      const out = await generateImage(ctx.imageProfile, prompt, { size, signal: ctx.signal });
      log('api', `image subcall ← ${ctx.imageProfile.model} (${out.urls.length} url, ${out.dataUrls.length} b64)`);
      // base64 results have no URL to relay; if the primary is multimodal, inline
      // them so the generated image isn't lost (it can describe/use it).
      const inlineImages =
        out.urls.length === 0 && ctx.visionInline && out.dataUrls.length ? out.dataUrls : undefined;
      const content = out.urls.length
        ? `已生成 ${out.urls.length} 张图片。请用 markdown 内联展示给用户(不要再 view_image 看它):\n${out.urls
            .map((u) => `![生成的图片](${u})`)
            .join('\n')}`
        : `已生成 ${out.dataUrls.length} 张图片(模型返回 base64 数据${inlineImages ? ',已作为图像呈现给你' : ''})。`;
      return {
        ok: true,
        toolContent: content,
        inlineImages,
        traceResult: { urls: out.urls, dataUrls: out.dataUrls.length },
      };
    } catch (e) {
      return {
        ok: false,
        toolContent: `图像生成(${ctx.imageProfile.model})失败:${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { ok: false, toolContent: `未知专门工具:${name}` };
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

    // Resolve capability slots. The agent loop runs on `primary`; vision / image
    // are delegated to their slots' models via tools (view_image/generate_image).
    const slots = await resolveSlots();
    const primary = slots.primary;
    if (!primary?.apiKey) {
      finish('error', '未配置主模型 API Key。请在「设置 → 模型分工」里为主模型指派一个已填 Key 的模型。');
      return;
    }
    if (!primary.baseUrl) {
      finish('error', '主模型未配置 Base URL。');
      return;
    }
    const cfg = primary; // {provider, baseUrl, apiKey, model}
    // Vision routing: if the vision slot IS the primary (multimodal main), images
    // go INLINE into the primary's own context; if it's a separate model, view_image
    // makes a sub-call to it; if unset, no view_image tool.
    const visionProfile = slots.vision;
    const visionInline = !!visionProfile && visionProfile.id === primary.id;
    const hasVisionTool = !!visionProfile;
    const imageProfile = slots.image;
    const hasImageTool = !!imageProfile;
    log('api', 'slots resolved', {
      primary: primary.model,
      vision: visionProfile ? visionProfile.model : 'none',
      visionMode: !visionProfile ? 'none' : visionInline ? 'inline(主模型自看)' : 'subcall(子调用专门模型)',
      image: imageProfile ? imageProfile.model : 'none',
    });

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

        // Offer specialist tools only for configured capability slots.
        const tools = [
          ...openAiToolsFromRegistry(),
          ...(hasVisionTool ? [VIEW_IMAGE_TOOL] : []),
          ...(hasImageTool ? [GENERATE_IMAGE_TOOL] : []),
        ];
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
                  content:
                    systemPromptApi() +
                    specialistSystemNote({ vision: hasVisionTool, image: hasImageTool }),
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

          // Specialist tools (view_image / generate_image) are intercepted here —
          // they don't go through the dispatcher; the engine routes them to the
          // capability slot's model.
          if (call.function.name === 'view_image' || call.function.name === 'generate_image') {
            const sr = await handleSpecialistCall(call.function.name, args, {
              visionProfile,
              visionInline,
              imageProfile,
              signal: ctx.signal,
            });
            if (sr.inlineImages?.length) turnImages.push(...sr.inlineImages);
            messages.push({ role: 'tool', tool_call_id: call.id, content: sr.toolContent });
            const sTrace = {
              id: traceId,
              action: 'execute_tool' as const,
              tool: call.function.name,
              args,
              status: (sr.ok ? 'completed' : 'failed') as 'completed' | 'failed',
              result: sr.traceResult,
              error: sr.ok ? undefined : sr.toolContent,
              durationMs: 0,
            };
            ctx.emit({ type: 'tool_trace', trace: sTrace });
            appendTurn(session, { role: 'tool_trace', trace: sTrace, ts: Date.now() });
            session.apiMessages = messages;
            await saveSession(session);
            continue;
          }

          const r = await ctx.executeTool({ tool: call.function.name, args });

          // Auto-attach only DATA URLs (screenshots) from a tool result: their
          // base64 can't round-trip through a view_image tool-call argument, so
          // a model can't ask for them by reference. http image URLs are NOT
          // auto-attached — the model requests those via view_image. Gated on
          // `visionInline` (the PRIMARY can see images) — if vision is a separate
          // specialist, a screenshot can't be auto-shown to the text primary.
          const images =
            visionInline && r.ok
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
