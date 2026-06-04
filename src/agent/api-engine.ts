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

import { openAiToolsFromRegistry, lookupAdapter } from '../tools/manifest';
import {
  systemPromptApi,
  systemPromptPlan,
  systemPromptSubagent,
  PROMPT_VERSION,
} from './api-system-prompt';
import { resolveSlots, type LlmProfile } from '../config/llm-config';
import { getActiveExploreSession } from '../explore/session';
import { visionDescribe, generateImage } from './specialist';
import { appendTurn, saveSession } from './session';
import type { AgentEngine, EngineContext, SessionDoneReason } from './engine';
import type { ApiMessage, ContentPart, ToolCall } from './api-types';
import { collectImageRefs, stripDataUrls, isDataUrl } from './tool-images';
import { log, warn, error as logError } from '../runtime/log';
import {
  DEFAULT_RETRY_POLICY,
  isRetriableNetworkError,
  isRetriableStatus,
  parseRetryAfter,
  retryDelayMs,
  sleep,
  ThrashTracker,
  NoProgressTracker,
  toolCallKey,
  type RetryPolicy,
} from './resilience';
import {
  DEFAULT_BUDGET,
  budgetVerdict,
  renderBudgetNote,
  shouldCompact,
  type BudgetConfig,
} from './budget';
import { applyCompaction, buildCompactionMessages, findCompactionBoundary } from './compaction';
import {
  isTerminal,
  looksLikeReplanRequest,
  parsePlanSteps,
  planProgress,
  renderPlanBlock,
  seedPlan,
} from './plan';
import { selectTools } from './tool-select';
import { createStreamAccumulator, parseSSEChunk } from './stream';
import { newRunMetrics, renderRunSummary } from './metrics';
import { addMemory, listMemories, renderMemoryBlock } from './memory-store';

const MAX_TOOL_RESULT_CHARS = 64_000;
/** Cap images fed to the model per turn (vision tokens are expensive, and a
 * turn with several image-returning tools could otherwise balloon). */
const MAX_VISION_IMAGES_PER_TURN = 8;
/** Stream the main assistant turn (SSE) for live feedback. Flip off if a
 * provider's endpoint doesn't support streaming / stream_options. */
const STREAM_MAIN_TURN = true;

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

/** Living todo/plan tool (Phase 1) — the model maintains a checklist for
 * multi-step tasks (TodoWrite semantics: pass the FULL step list each call).
 * Intercepted by the engine, never dispatched. */
const UPDATE_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_plan',
    description:
      '维护当前任务的待办清单(todo)。任务有 3 步以上时强烈建议使用:先列出步骤,再随进展更新。规则:每次调用传入【完整】的步骤列表(不是增量);开始做某步前标 in_progress,做完立刻标 completed;主动跳过的标 skipped、尝试过但失败的标 failed(后两者在 activeForm 写一句原因)。任何时刻最多一个 in_progress,且必须如实——没做的别标 completed。这能帮你在长任务里不跑偏。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '完整的步骤列表,按执行顺序',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '步骤简述' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'skipped', 'failed'],
                description:
                  '该步骤状态:pending 未开始 / in_progress 进行中 / completed 已完成 / skipped 主动跳过 / failed 尝试失败',
              },
              activeForm: {
                type: 'string',
                description: '可选:进行时描述(如「正在抓取首页」),或 skipped/failed 时的简短原因',
              },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
};

/** submit_plan (Phase 2 plan mode) — the model proposes a stepwise plan for the
 * user to approve before leaving the read-only planning phase. Intercepted. */
const SUBMIT_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_plan',
    description:
      '提交一个分步执行计划(规划模式)。goal 一句话目标;steps 有序步骤(每步一句、具体可执行,写操作显式列为步骤)。提交后会把计划弹给用户确认/修改,用户确认后才进入执行。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '一句话目标' },
        steps: {
          type: 'array',
          description: '有序的步骤清单',
          items: { type: 'string' },
        },
      },
      required: ['goal', 'steps'],
    },
  },
};

/** spawn_subagent (Phase 4) — delegate a bounded subtask to an isolated-context
 * sub-agent and get back only its text digest, so bulky intermediate data never
 * enters the main conversation. Read-only, serial, no nesting. Intercepted. */
const SUBAGENT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'spawn_subagent',
    description:
      '把一个【有界的子任务】(如「抓取并对比这 20 条笔记」)交给一个隔离上下文的子 agent 去做,只拿回它的文字结论。适合会产生大量中间数据的子任务——这样主对话不会被原始数据撑爆。子 agent 只读、串行、不能再派生子 agent。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给子 agent 的具体子任务(要自包含——它看不到主对话历史)',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: '可选:限制子 agent 只能用这些工具(全名,如 xiaohongshu__feed)',
        },
      },
      required: ['task'],
    },
  },
};

/** remember (long-term memory) — persist a durable user fact/preference across
 * sessions. Intercepted; recalled into the system prompt on future runs. */
const REMEMBER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'remember',
    description:
      '把一条关于用户的【长期事实或偏好】记下来,跨会话保留(例如「用户常用的小红书账号是 X」「用户偏好简洁的回答」)。只记真正长期有用的;一次一条、简短。不要记一次性的任务细节或临时信息。',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string', description: '要记住的一条简短事实/偏好' } },
      required: ['fact'],
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
  if (caps.image) lines.push('- 图像生成(generate_image):用户要画图/生成图片时调用,返回图片 URL。');
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

/** Perception primitives surfaced to the model ONLY in explore mode (they read
 * the active explore session's capture). Tool names are `${site}__${name}`. */
const EXPLORE_ONLY_TOOLS = new Set(['generic__list_network', 'generic__get_html']);

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
      ? (args as { images: unknown[] }).images.filter((u): u is string => typeof u === 'string')
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
      return {
        ok: false,
        toolContent: '图像生成模型未填 API Key 或 Base URL,请在「模型分工」检查。',
      };
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return { ok: false, toolContent: 'prompt 不能为空。' };
    const size = typeof args.size === 'string' ? args.size : undefined;
    log('api', `image subcall → ${ctx.imageProfile.model}`, { baseUrl: ctx.imageProfile.baseUrl });
    try {
      const out = await generateImage(ctx.imageProfile, prompt, { size, signal: ctx.signal });
      log(
        'api',
        `image subcall ← ${ctx.imageProfile.model} (${out.urls.length} url, ${out.dataUrls.length} b64)`,
      );
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
        (m as { content: unknown[] }).content.some(
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
      if (
        key === 'url' &&
        typeof value === 'string' &&
        value.startsWith('data:') &&
        value.length > 120
      ) {
        return value.slice(0, 80) + `…[${value.length} chars base64]`;
      }
      // Trim very long tool/text content so the body is scannable.
      if (
        (key === 'content' || key === 'text') &&
        typeof value === 'string' &&
        value.length > 600
      ) {
        return value.slice(0, 600) + `…[${value.length} chars]`;
      }
      return value;
    }),
  );
}

export async function chatCompletion(opts: {
  apiKey: string;
  baseUrl: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  /** Bounded-retry policy for transient faults; defaults to DEFAULT_RETRY_POLICY. */
  policy?: RetryPolicy;
  /** Stream the response (SSE) and call onText with the growing content. */
  stream?: boolean;
  onText?: (text: string) => void;
}): Promise<ChatCompletionResponse> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
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
  const reqBody = opts.stream
    ? { ...opts.body, stream: true, stream_options: { include_usage: true } }
    : opts.body;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(reqBody),
    signal: opts.signal,
  };

  // Bounded retry with backoff. A single transient fault (network blip, 429,
  // 5xx) used to kill the WHOLE session via finish('error') — fatal for a long
  // loop where step 25 hits one hiccup. We retry transient faults only: a 4xx
  // (bad request / auth) won't self-heal so it throws straight through, and an
  // AbortError (user hit Stop) is never retried. See resilience.ts / §10.1.
  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const isLast = attempt === policy.maxAttempts - 1;
    const t0 = Date.now();
    try {
      const resp = await fetch(url, init);
      const elapsed = Date.now() - t0;
      if (!resp.ok) {
        const text = await resp.text();
        if (isRetriableStatus(resp.status) && !isLast) {
          const delay = retryDelayMs(
            attempt,
            policy,
            parseRetryAfter(resp.headers.get('retry-after')),
          );
          warn(
            'api',
            `← ${resp.status} (${elapsed}ms) — 第 ${attempt + 1}/${policy.maxAttempts} 次,${delay}ms 后重试`,
            { body: text.slice(0, 300) },
          );
          await sleep(delay, opts.signal);
          continue;
        }
        // Non-retriable (other 4xx) or out of attempts: surface the real error.
        // This is a plain Error, so the catch below won't mistake it for a
        // retriable network fault.
        logError('api', `← ${resp.status} (${elapsed}ms)`, { body: text.slice(0, 1000) });
        throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 500)}`);
      }
      if (opts.stream && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        const acc = createStreamAccumulator();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSSEChunk(buf);
          buf = rest;
          for (const ev of events) acc.push(ev);
          if (events.length && opts.onText) opts.onText(acc.result().content);
        }
        const a = acc.result();
        log('api', `← 200 stream (${elapsed}ms)${attempt > 0 ? ` (重试后)` : ''}`, {
          finish: a.finish_reason,
          textLen: a.content.length,
          toolCalls: a.tool_calls.length,
          usage: a.usage,
        });
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: a.content || null,
                reasoning_content: a.reasoning_content || null,
                tool_calls: a.tool_calls.length ? a.tool_calls : undefined,
              },
              finish_reason: a.finish_reason ?? 'stop',
            },
          ],
          usage: a.usage,
        };
      }
      const json = (await resp.json()) as ChatCompletionResponse;
      log('api', `← 200 (${elapsed}ms)${attempt > 0 ? ` (第 ${attempt} 次重试后成功)` : ''}`, {
        finish: json.choices?.[0]?.finish_reason,
        textLen: json.choices?.[0]?.message?.content?.length ?? 0,
        thinkingLen: json.choices?.[0]?.message?.reasoning_content?.length ?? 0,
        toolCalls: json.choices?.[0]?.message?.tool_calls?.length ?? 0,
        usage: json.usage,
      });
      return json;
    } catch (e) {
      // Stop pressed → propagate at once, never retry.
      if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
      lastErr = e;
      if (isRetriableNetworkError(e) && !isLast) {
        const delay = retryDelayMs(attempt, policy);
        warn('api', `网络错误 — 第 ${attempt + 1}/${policy.maxAttempts} 次,${delay}ms 后重试`, {
          err: e instanceof Error ? e.message : String(e),
        });
        await sleep(delay, opts.signal);
        continue;
      }
      throw e; // non-retriable (incl. the LLM API error thrown above) or exhausted
    }
  }
  /* loop always returns or throws above; this satisfies the type checker */
  throw lastErr ?? new Error('chatCompletion: 重试耗尽');
}

/** Injectable seam for tests: override the LLM call, resolved slots, and budget
 * so the loop runs with a fake model and no IndexedDB / chrome.storage.
 * Production passes nothing — all three fall back to the real implementations. */
export interface ApiEngineDeps {
  complete?: typeof chatCompletion;
  slots?: Awaited<ReturnType<typeof resolveSlots>>;
  budget?: BudgetConfig;
}

export async function runApiSession(ctx: EngineContext, deps: ApiEngineDeps = {}): Promise<void> {
  const { session } = ctx;
  const metrics = newRunMetrics(Date.now());
  const complete = deps.complete ?? chatCompletion;
  const budget = deps.budget ?? DEFAULT_BUDGET;

  function finish(reason: SessionDoneReason, err?: string): void {
    session.status = reason === 'error' ? 'error' : reason === 'user_abort' ? 'aborted' : 'idle';
    void saveSession(session);
    log('metrics', renderRunSummary(metrics, Date.now(), reason));
    ctx.emit({ type: 'session_done', reason, error: err });
    log('api', `session=${session.id} done`, { reason, err });
  }

  // Resolve capability slots. The agent loop runs on `primary`; vision / image
  // are delegated to their slots' models via tools (view_image/generate_image).
  const slots = deps.slots ?? (await resolveSlots());
  const primary = slots.primary;
  if (!primary?.apiKey) {
    finish(
      'error',
      '未配置主模型 API Key。请在「设置 → 模型分工」里为主模型指派一个已填 Key 的模型。',
    );
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
    visionMode: !visionProfile
      ? 'none'
      : visionInline
        ? 'inline(主模型自看)'
        : 'subcall(子调用专门模型)',
    image: imageProfile ? imageProfile.model : 'none',
  });

  session.status = 'running';
  session.iterations = 0;

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

  // Set when a drained steer reads as a "give me a plan to confirm" request
  // (§10.16). Consumed at the top of the execution loop → re-enters planning.
  let pendingReplan = false;

  /** Fold any queued steering messages ("插话" injected mid-run) into the live
   * context, persisting them as user turns + apiMessages immediately so a steer
   * is never lost even if the run ends right after. Returns true if ≥1 was
   * folded — a caller at a loop-exit should then `continue` so the model gets a
   * turn to actually answer it instead of finishing. See docs/agent-harness.md §10.14. */
  async function drainSteers(): Promise<boolean> {
    const steers = ctx.takeSteerMessages();
    if (!steers.length) return false;
    for (const s of steers) {
      messages.push({ role: 'user', content: s });
      appendTurn(session, { role: 'user', text: s, ts: Date.now() });
      if (looksLikeReplanRequest(s)) pendingReplan = true; // §10.16: 插话要计划
      log('api', `steered: ${s.slice(0, 60)}`);
    }
    session.apiMessages = messages;
    await saveSession(session);
    return true;
  }

  log('api', `session=${session.id} run() begin`, {
    userText: ctx.userText.slice(0, 80),
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    historyLen: messages.length,
    promptVersion: PROMPT_VERSION,
    mode: ctx.mode ?? 'chat',
  });

  // Long-term memory recall: load the user's saved facts once and inject them
  // into the system prompt for this whole run (both planning and execution).
  const memoryBlock = renderMemoryBlock(await listMemories().catch(() => []));
  // Environment note (e.g. disabled func adapters) so the model doesn't
  // silently fall back to generic tools and fake an unavailable capability.
  const envNote = ctx.environmentNote
    ? `\n\n## 运行环境提示\n${ctx.environmentNote}\n如果任务需要这些当前不可用的站点工具,请如实告知用户去启用,不要用 generic 工具硬凑、假装能完成。`
    : '';

  // Explore mode: drive the site once on the dedicated explore tab while the
  // system records a trace; synthesis happens after the run (SW side).
  const exploreNote =
    ctx.mode === 'explore'
      ? (() => {
          const tabId = getActiveExploreSession()?.tabId;
          const tab = tabId === undefined ? '探索标签页' : `标签页 tabId=${tabId}`;
          return `\n\n## 探索模式(Explore)\n你正在"探索"一个站点:把用户要的这次任务在真实页面上**亲手做一遍**,系统会全程录制(动作 + 网络 + DOM),之后据此自动合成一个可重复运行的适配器(你不用写代码)。要点:\n- 只在${tab}上操作:用 open_url 导航(会复用该标签页),click / type_into / get_interactives 等都把 tab_id 设为该标签页。\n- 核心目标是"找到数据真正来自哪里":多用 list_network 查看抓到的 XHR/Fetch 接口,优先确认有没有直接返回业务数据的接口;必要时用 get_html 看 DOM 结构。\n- 把任务完整做一遍(真的搜索 / 翻页 / 打开详情),让关键接口都被触发、数据都出现在网络或 DOM 里。\n- 做完后用文字总结你发现的数据路径(哪个接口或哪些选择器)。`;
        })()
      : '';

  // Re-pull tools each iteration so a market install mid-conversation shows
  // up on the very next LLM call (no need to start a new session). Cheap —
  // building the schema array is sub-millisecond — and avoids stale tools
  // that the LLM has been told it can call but the registry no longer holds.
  // Track the registry version we last reported, so a one-liner log only
  // fires when the set actually changed.
  let lastToolsCount = -1;
  // Adaptive budget + anti-thrash (slice 2): the model is told its step
  // budget so it paces itself; hitting the cap yields a graceful, resumable
  // checkpoint instead of a bare max_iterations. A repeatedly-failing tool
  // call breaks the loop instead of burning the whole budget.
  const thrash = new ThrashTracker();
  const noProgress = new NoProgressTracker();
  let lastPromptTokens = 0;
  let reflectedOnce = false; // plan-mode finishing reflection fires at most once

  // Structured-LLM compaction: when prompt tokens cross the soft limit,
  // summarize the older half of the message array into one progress-ledger
  // message so a long loop doesn't blow the context window. Mutates `messages`
  // in place (the persisted reference stays valid). Best-effort — a failed
  // summarizer sub-call just skips (the hard-token checkpoint is the backstop).
  async function compactIfNeeded(): Promise<void> {
    if (!shouldCompact(lastPromptTokens, budget)) return;
    const idx = findCompactionBoundary(messages);
    if (idx < 2) return;
    const older = messages.slice(0, idx);
    let resp: ChatCompletionResponse;
    try {
      resp = await complete({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        signal: ctx.signal,
        body: { model: cfg.model, messages: buildCompactionMessages(older), max_tokens: 1024 },
      });
    } catch (e) {
      warn('api', 'compaction sub-call failed; skipping', e);
      return;
    }
    const summary = resp.choices?.[0]?.message?.content ?? '';
    if (!summary.trim()) return;
    const removed = applyCompaction(messages, summary, idx);
    if (removed <= 0) return;
    metrics.compactions++;
    lastPromptTokens = 0; // next real response re-measures
    session.apiMessages = messages;
    await saveSession(session);
    log('api', `compacted ${removed} msgs → summary`, { summaryLen: summary.length });
    ctx.emit({
      type: 'notice',
      level: 'info',
      text: '已把较早的对话压缩成进度摘要,腾出上下文空间(继续执行)。',
    });
  }

  // ── Plan mode: read-only planning phase ──────────────────────────────
  // Research with read-only tools → submit_plan → user approval. On approval
  // session.plan is set+approved and we fall through to the execution loop.
  const PLAN_MAX_STEPS = 12;
  let planError = '';
  async function runPlanningPhase(): Promise<
    'approved' | 'answered' | 'rejected' | 'error' | 'aborted'
  > {
    // Bounded nudging instead of a forced tool_choice — some providers (GLM-5
    // in thinking mode) hard-400 on an object/required tool_choice. §10.17
    const MAX_PLAN_NUDGES = 3;
    let planNudges = 0;
    for (let pIter = 0; pIter < PLAN_MAX_STEPS; pIter++) {
      if (ctx.signal.aborted) return 'aborted';
      const iterationId = `${session.id}__plan${pIter}`;
      ctx.emit({ type: 'iteration_progress', iteration: pIter, iterationId, phase: 'awaiting' });

      // Read-only registry tools + submit_plan (+ vision). Write tools are
      // filtered out so the planning phase truly cannot mutate anything.
      const tools = [
        ...selectTools(
          openAiToolsFromRegistry().filter(
            (t) => lookupAdapter(t.function.name)?.access !== 'write',
          ),
          ctx.userText,
        ).tools,
        SUBMIT_PLAN_TOOL,
        ...(hasVisionTool ? [VIEW_IMAGE_TOOL] : []),
      ];

      let resp: ChatCompletionResponse;
      try {
        resp = await complete({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          signal: ctx.signal,
          body: {
            model: cfg.model,
            messages: [
              { role: 'system', content: systemPromptPlan() + memoryBlock + envNote },
              ...messages,
            ],
            tools,
            tool_choice: 'auto',
            max_tokens: 4096,
          },
        });
      } catch (e) {
        if (ctx.signal.aborted) return 'aborted';
        logError('api', 'planning chatCompletion failed', e);
        planError = e instanceof Error ? e.message : String(e);
        return 'error';
      }
      lastPromptTokens = resp.usage?.prompt_tokens ?? lastPromptTokens;
      const choice = resp.choices?.[0];
      if (!choice) {
        planError = 'LLM 没有返回任何 choices';
        return 'error';
      }
      const msg = choice.message;
      const text = msg.content ?? '';
      const thinking = msg.reasoning_content ?? undefined;
      const toolCalls = msg.tool_calls;
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
        iteration: pIter,
        ts: Date.now(),
      });
      ctx.emit({
        type: 'assistant_turn',
        iteration: pIter,
        cleanedText: text,
        reasoningText: thinking,
        commands: [],
      });
      ctx.emit({ type: 'iteration_progress', iteration: pIter, iterationId, phase: 'completed' });
      session.apiMessages = messages;
      await saveSession(session);

      // Plan mode: the user explicitly wants to confirm a plan — don't let the
      // model answer directly and skip it. Firmly nudge toward submit_plan;
      // bounded so we don't loop forever — if the model still won't plan, let its
      // answer through rather than erroring (some models just won't). §10.16/§10.17
      if (!toolCalls || toolCalls.length === 0) {
        if (planNudges >= MAX_PLAN_NUDGES) {
          ctx.emit({
            type: 'notice',
            level: 'warning',
            text: '模型未提交可确认的计划,已直接作答(当前模型/端点可能不便强制计划)。',
          });
          return 'answered';
        }
        planNudges++;
        messages.push({
          role: 'user',
          content:
            '「先计划再执行」模式下,请现在就用 submit_plan 提交计划供用户确认——可以把"先研究X"写成计划里的步骤,不要直接作答、也不要现在就执行。',
        });
        appendTurn(session, {
          role: 'user',
          text: '[规划] 要求先给出可确认的计划',
          ts: Date.now(),
        });
        session.apiMessages = messages;
        await saveSession(session);
        continue;
      }

      for (const call of toolCalls) {
        if (ctx.signal.aborted) return 'aborted';
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          warn('api', `bad JSON arguments for ${call.function.name}`, {
            arguments: call.function.arguments,
          });
        }
        const traceId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const startTrace = {
          id: traceId,
          action: 'execute_tool' as const,
          tool: call.function.name,
          args,
          status: 'started' as const,
        };
        ctx.emit({ type: 'tool_trace', trace: startTrace });
        appendTurn(session, { role: 'tool_trace', trace: startTrace, ts: Date.now() });

        const emitFinal = (
          status: 'completed' | 'failed',
          extra: { result?: unknown; error?: string } = {},
        ): void => {
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status,
            durationMs: 0,
            ...extra,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
        };
        const ackTool = async (content: string): Promise<void> => {
          messages.push({ role: 'tool', tool_call_id: call.id, content });
          session.apiMessages = messages;
          await saveSession(session);
        };

        // submit_plan → approval gate.
        if (call.function.name === 'submit_plan') {
          const goal = typeof args.goal === 'string' ? args.goal : '';
          const proposed = seedPlan(goal, (args as { steps?: unknown[] }).steps ?? [], Date.now());
          log(
            'api',
            `submit_plan intercepted: ${proposed.steps.length} steps → requesting approval`,
          );
          if (proposed.steps.length === 0) {
            await ackTool('计划为空,请给出具体的步骤列表。');
            emitFinal('failed', { error: 'empty plan' });
            continue;
          }
          // Explicit plan mode: the user chose 先计划再执行 — ALWAYS show the
          // approval card so they confirm/edit before execution. No model-judged
          // "simple" auto-skip; that silently bypassed the user's choice. §10.16
          const decision = await ctx.requestPlanDecision(proposed);
          if (ctx.signal.aborted) return 'aborted';
          if (decision.decision === 'approve') {
            const steps =
              decision.editedSteps && decision.editedSteps.length
                ? seedPlan(goal, decision.editedSteps, Date.now()).steps
                : proposed.steps;
            session.plan = { goal: proposed.goal, steps, updatedAt: Date.now(), approved: true };
            ctx.emit({ type: 'plan_updated', plan: session.plan });
            await ackTool(
              `用户已批准计划(${steps.length} 步)。现在进入执行阶段,按计划逐步执行,并用 update_plan 更新进度。`,
            );
            emitFinal('completed', { result: session.plan });
            return 'approved';
          }
          const fb = decision.feedback?.trim();
          if (!fb) {
            await ackTool('用户取消了该计划。');
            emitFinal('completed');
            return 'rejected';
          }
          await ackTool(`用户未批准,反馈:${fb}。请据此修改后重新 submit_plan。`);
          emitFinal('completed');
          continue;
        }

        // Block writes during planning (belt-and-suspenders; also filtered out).
        if (lookupAdapter(call.function.name)?.access === 'write') {
          await ackTool('规划阶段为只读,不能执行写操作。请把它写进计划,批准后再执行。');
          emitFinal('failed', { error: 'write blocked in planning' });
          continue;
        }

        // Read-only vision sub-call during planning.
        if (call.function.name === 'view_image' || call.function.name === 'generate_image') {
          const sr = await handleSpecialistCall(call.function.name, args, {
            visionProfile,
            visionInline,
            imageProfile,
            signal: ctx.signal,
          });
          await ackTool(sr.toolContent);
          emitFinal(sr.ok ? 'completed' : 'failed', {
            result: sr.traceResult,
            error: sr.ok ? undefined : sr.toolContent,
          });
          continue;
        }

        // Read tool — execute via the dispatcher.
        const r = await ctx.executeTool({ tool: call.function.name, args });
        const rawResult = stripDataUrls(
          r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `错误: ${r.error ?? '(unknown)'}`,
        );
        await ackTool(truncate(rawResult));
        emitFinal(r.ok ? 'completed' : 'failed', { result: r.result, error: r.error });
      }
    }
    planError = '规划阶段未在步数内产出可批准的计划';
    return 'error';
  }

  // ── Sub-agent (Phase 4): an isolated-context bounded subtask. Its messages
  // never touch the main array; only its final text digest is returned to the
  // main loop. Read-only + serial (the tab/CDP world isn't concurrency-safe).
  const SUBAGENT_MAX_STEPS = 15;
  async function runSubagent(task: string, allowedTools?: string[]): Promise<string> {
    const allow = new Set(allowedTools ?? []);
    const subTools = openAiToolsFromRegistry().filter((t) => {
      if (lookupAdapter(t.function.name)?.access === 'write') return false; // read-only
      if (allow.size && !allow.has(t.function.name)) return false;
      return true;
    });
    const subMessages: ApiMessage[] = [{ role: 'user', content: task }];
    let last = '';
    for (let i = 0; i < SUBAGENT_MAX_STEPS; i++) {
      if (ctx.signal.aborted) return last || '(子 agent 被中断)';
      let resp: ChatCompletionResponse;
      try {
        resp = await complete({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          signal: ctx.signal,
          body: {
            model: cfg.model,
            messages: [{ role: 'system', content: systemPromptSubagent() }, ...subMessages],
            tools: subTools,
            tool_choice: 'auto',
            max_tokens: 4096,
          },
        });
      } catch (e) {
        if (ctx.signal.aborted) return last || '(子 agent 被中断)';
        return `子 agent 调用失败:${e instanceof Error ? e.message : String(e)}`;
      }
      const choice = resp.choices?.[0];
      if (!choice) return last || '(子 agent 无返回)';
      const msg = choice.message;
      if (msg.content) last = msg.content;
      const toolCalls = msg.tool_calls;
      subMessages.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls || toolCalls.length === 0) return last.trim() || '(子 agent 无结论)';
      for (const call of toolCalls) {
        if (ctx.signal.aborted) return last || '(子 agent 被中断)';
        let a: Record<string, unknown> = {};
        try {
          a = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* ignore bad args */
        }
        // No writes, no recursion inside a sub-agent.
        if (
          call.function.name === 'spawn_subagent' ||
          lookupAdapter(call.function.name)?.access === 'write'
        ) {
          subMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: '子 agent 不能执行该工具(写操作 / 嵌套子 agent 已禁止)。',
          });
          continue;
        }
        const r = await ctx.executeTool({ tool: call.function.name, args: a });
        const txt = stripDataUrls(
          r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `错误: ${r.error ?? '(unknown)'}`,
        );
        subMessages.push({ role: 'tool', tool_call_id: call.id, content: truncate(txt) });
      }
    }
    return last.trim() || '(子 agent 达到步数上限,未得出明确结论)';
  }

  try {
    if (ctx.mode === 'plan') {
      const planResult = await runPlanningPhase();
      if (planResult === 'aborted') return finish('user_abort');
      if (planResult === 'answered') return finish('no_more_commands');
      if (planResult === 'rejected') {
        ctx.emit({ type: 'notice', level: 'info', text: '已取消(计划未获批准)。' });
        return finish('no_more_commands');
      }
      if (planResult === 'error') return finish('error', planError || '规划阶段失败');
      // 'approved' → fall through to the execution loop with session.plan set.
    }
    for (let iter = 0; ; iter++) {
      if (ctx.signal.aborted) return finish('user_abort');
      // Steering: fold in any messages the user injected mid-run. Safe at the
      // top of an iteration — all prior tool_calls are answered, so inserting a
      // user message can't orphan a tool_call. The SAME drain also runs before
      // every finish (below), so a steer that lands on the final turn isn't
      // dropped + lost on reload. See docs/agent-harness.md §10.14.
      await drainSteers();
      // Mid-run re-plan (§10.16): an interjection asking for a plan to confirm
      // re-enters the planning phase (submit_plan → approval card) before
      // continuing, so the user gets a confirmable plan even mid-execution.
      if (pendingReplan) {
        pendingReplan = false;
        ctx.emit({ type: 'notice', level: 'info', text: '按你的中途要求,重新规划并请你确认…' });
        const replan = await runPlanningPhase();
        if (replan === 'aborted') return finish('user_abort');
        if (replan === 'error') return finish('error', planError || '重新规划失败');
        if (replan === 'rejected') {
          ctx.emit({ type: 'notice', level: 'info', text: '你取消了新计划,保留原计划继续。' });
        }
        // 'approved' → session.plan is the revised plan; fall through to execute it.
      }
      // Soft token limit → summarize older history before the next call so a
      // long loop doesn't blow the context window (slice 3).
      await compactIfNeeded();
      // Budget gate — checkpoint (resumable) rather than dead-stop.
      const verdict = budgetVerdict(iter, lastPromptTokens, budget);
      if (verdict.stop) {
        const why =
          verdict.reason === 'steps'
            ? `已到本轮步数上限(${budget.maxSteps} 步)`
            : '上下文已接近模型上限';
        log('api', `session=${session.id} checkpoint`, {
          reason: verdict.reason,
          iter,
          lastPromptTokens,
        });
        ctx.emit({
          type: 'notice',
          level: 'info',
          text: `${why},先在此暂存进度。发送「继续」可接着完成(保留上下文)。`,
        });
        return finish('checkpoint');
      }
      session.iterations = iter;
      metrics.steps = iter + 1;
      const iterationId = `${session.id}__api${iter}`;

      ctx.emit({ type: 'iteration_progress', iteration: iter, iterationId, phase: 'awaiting' });

      // Offer specialist tools only for configured capability slots.
      // Explore-only perception primitives (list_network / get_html) are hidden
      // outside explore mode so they don't clutter the normal tool list.
      const selected = selectTools(openAiToolsFromRegistry(), ctx.userText).tools;
      const baseTools =
        ctx.mode === 'explore'
          ? selected
          : selected.filter((t) => !EXPLORE_ONLY_TOOLS.has(t.function.name));
      const tools = [
        ...baseTools,
        UPDATE_PLAN_TOOL,
        SUBAGENT_TOOL,
        REMEMBER_TOOL,
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

      let lastStreamLen = 0;
      let resp: ChatCompletionResponse;
      try {
        resp = await complete({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          signal: ctx.signal,
          stream: STREAM_MAIN_TURN,
          onText: (t) => {
            if (t.length - lastStreamLen >= 32) {
              lastStreamLen = t.length;
              ctx.emit({ type: 'assistant_delta', iteration: iter, text: t });
            }
          },
          body: {
            model: cfg.model,
            messages: [
              {
                role: 'system',
                content:
                  systemPromptApi() +
                  specialistSystemNote({ vision: hasVisionTool, image: hasImageTool }) +
                  renderBudgetNote(iter, budget) +
                  (session.plan
                    ? renderPlanBlock(session.plan)
                    : '\n\n多步任务(≥3 步)建议先用 update_plan 列出待办清单再开始。') +
                  memoryBlock +
                  envNote +
                  exploreNote,
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

      // Track real prompt-token usage (free, from the provider) for the
      // budget gate + compaction trigger (slice 3).
      lastPromptTokens = resp.usage?.prompt_tokens ?? lastPromptTokens;
      metrics.promptTokens = lastPromptTokens;
      metrics.completionTokens += resp.usage?.completion_tokens ?? 0;
      ctx.emit({
        type: 'run_stats',
        step: iter + 1,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
      });

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

      if (!toolCalls || toolCalls.length === 0) {
        // Reflect & re-plan (plan mode): on a finish attempt, do ONE self-check
        // against the approved plan — finish leftover steps, or (if all done)
        // confirm the goal is actually met and re-plan via update_plan if not.
        // Once per run so it can't loop forever.
        if (!reflectedOnce && session.plan?.approved) {
          reflectedOnce = true;
          const goalLine = session.plan.goal ? `目标:${session.plan.goal}\n` : '';
          const unsettled = session.plan.steps.filter((s) => !isTerminal(s.status));
          if (unsettled.length) {
            // Finish-time reconcile (§10.15): the model is wrapping up but left
            // steps unsettled. Force ONE truthful update_plan so the checklist
            // never lies — each step ends as completed / skipped / failed (with a
            // reason), not silently left pending. We do NOT auto-stamp them
            // completed: that would fake success. Truthful > clean.
            const pending = unsettled.map((s) => `- ${s.title}`).join('\n');
            messages.push({
              role: 'user',
              content:
                `[对账] ${goalLine}你正要结束,但这些计划步骤还没有结果标记:\n${pending}\n` +
                '用 update_plan 传回【完整】步骤列表,把每个步骤如实更新到终态:真正做完→completed;主动跳过(不需要/前置条件不满足)→skipped;尝试过但没成→failed。skipped/failed 在 activeForm 写一句原因。不要把没做的标成 completed,也不要漏标。',
            });
            appendTurn(session, {
              role: 'user',
              text: '[对账] 如实标记每个计划步骤的结果',
              ts: Date.now(),
            });
            ctx.emit({
              type: 'notice',
              level: 'info',
              text: '让模型如实对账计划各步结果(完成/跳过/失败)…',
            });
          } else {
            // Every step is already in a terminal state → one goal self-check.
            messages.push({
              role: 'user',
              content: `[自检] ${goalLine}计划每一步都有结果了。最后自检一遍:是否真的达成了上面的目标?有没有遗漏、质量不足或值得补强的地方?如需补做,用 update_plan 加步骤后继续;若确认无误,用一条【不带任何工具调用】的消息给出【完整、详细】的最终答复(别只给一句总结)。`,
            });
            appendTurn(session, { role: 'user', text: '[自检] 对照计划复盘', ts: Date.now() });
            ctx.emit({
              type: 'notice',
              level: 'info',
              text: '计划各步已落定,让模型对照目标自检一遍…',
            });
          }
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }
        // A steer can land DURING this final turn (the user reacts to the
        // streaming answer). Drain before finishing: if one is pending, fold it
        // in and loop once more so the model actually answers it. Without this
        // it'd be discarded here and vanish on reload. §10.14
        if (await drainSteers()) continue;
        return finish('no_more_commands');
      }

      // Images collected from ALL tool results this turn. Pushed as ONE user
      // message AFTER the loop — interleaving a user message between tool
      // messages would break the "every tool_call_id answered contiguously
      // before the next non-tool message" contract when there are ≥2 calls.
      const turnImages: string[] = [];
      let breaker: string | null = null;
      let anyToolSuccess = false;

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

        // update_plan (Phase 1): intercepted — maintain the living todo list,
        // push it to the UI, ack the model. Never goes through the dispatcher.
        if (call.function.name === 'update_plan') {
          const steps = parsePlanSteps((args as { steps?: unknown }).steps);
          session.plan = {
            ...(session.plan?.goal ? { goal: session.plan.goal } : {}),
            steps,
            updatedAt: Date.now(),
          };
          const prog = planProgress(session.plan);
          ctx.emit({ type: 'plan_updated', plan: session.plan });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `已更新待办清单(${prog.completed}/${prog.total} 完成)。`,
          });
          const pTrace = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            result: session.plan,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: pTrace });
          appendTurn(session, { role: 'tool_trace', trace: pTrace, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // spawn_subagent (Phase 4): run an isolated subtask, fold only its
        // text digest into the main context. Intercepted; never dispatched.
        if (call.function.name === 'spawn_subagent') {
          const task = typeof args.task === 'string' ? args.task.trim() : '';
          const allowed = Array.isArray((args as { allowed_tools?: unknown }).allowed_tools)
            ? (args as { allowed_tools: unknown[] }).allowed_tools.filter(
                (x): x is string => typeof x === 'string',
              )
            : undefined;
          if (!task) {
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'task 不能为空。' });
            const t = {
              id: traceId,
              action: 'execute_tool' as const,
              tool: call.function.name,
              args,
              status: 'failed' as const,
              error: 'empty task',
              durationMs: 0,
            };
            ctx.emit({ type: 'tool_trace', trace: t });
            appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
            session.apiMessages = messages;
            await saveSession(session);
            continue;
          }
          ctx.emit({
            type: 'notice',
            level: 'info',
            text: `🧵 子 agent 开始:${task.slice(0, 60)}`,
          });
          const subStart = Date.now();
          const digest = await runSubagent(task, allowed);
          metrics.subagents++;
          messages.push({ role: 'tool', tool_call_id: call.id, content: digest });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            result: { digestChars: digest.length },
            durationMs: Date.now() - subStart,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          ctx.emit({
            type: 'notice',
            level: 'info',
            text: `🧵 子 agent 完成(${digest.length} 字)`,
          });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // remember (long-term memory): persist a user fact, ack the model.
        if (call.function.name === 'remember') {
          const fact = typeof args.fact === 'string' ? args.fact : '';
          const saved = await addMemory(fact);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: saved ? `已记住:${saved.text}` : '没有可记录的内容(fact 为空)。',
          });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: (saved ? 'completed' : 'failed') as 'completed' | 'failed',
            result: saved ?? undefined,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

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
          breaker = thrash.record(toolCallKey(call.function.name, args), sr.ok);
          if (breaker) break;
          continue;
        }

        const r = await ctx.executeTool({ tool: call.function.name, args });
        metrics.toolCalls++;
        if (r.ok) anyToolSuccess = true;
        else metrics.toolErrors++;

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
        breaker = thrash.record(toolCallKey(call.function.name, args), r.ok);
        if (breaker) break;
      }

      // Anti-thrash: the same call kept failing → stop instead of burning the
      // rest of the budget. The current call is answered (its tool msg pushed);
      // any unexecuted sibling calls are padded by sanitizeHistory on resume.
      if (breaker) {
        warn('api', `thrash breaker: ${breaker}`);
        ctx.emit({
          type: 'notice',
          level: 'warning',
          text: `${breaker} 已暂停;换个说法或补充信息后发送「继续」。`,
        });
        return finish('checkpoint');
      }

      // No-progress breaker (plan mode only): genuinely stuck (no plan
      // progress AND no successful tool call for N turns) → checkpoint.
      if (session.plan?.approved) {
        const stall = noProgress.record(planProgress(session.plan).settled, anyToolSuccess);
        if (stall) {
          warn('api', `no-progress breaker: ${stall}`);
          ctx.emit({
            type: 'notice',
            level: 'warning',
            text: `${stall} 可以补充信息或换个说法后发送「继续」。`,
          });
          return finish('checkpoint');
        }
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

      if (choice.finish_reason !== 'tool_calls') {
        // §10.14: a steer can arrive during this turn too — fold + loop instead
        // of dropping it.
        if (await drainSteers()) continue;
        return finish('no_more_commands');
      }
    }
  } finally {
    session.apiMessages = messages;
    await saveSession(session);
  }
}

export const apiEngine: AgentEngine = {
  kind: 'api',
  run: (ctx) => runApiSession(ctx),
};
