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

import { openAiToolsFromRegistry, lookupAdapter } from '@base/tools/manifest';
import {
  systemPromptApi,
  systemPromptPlan,
  systemPromptSubagent,
  PROMPT_VERSION,
} from './api-system-prompt';
import { resolveSlots, needsBaseUrl } from '../config/llm-config';
import { getActiveExploreSession } from '../explore/session';
import { visionDescribe, imageUrlForProvider, providerAcceptsHttpImageUrl } from './specialist';
import { appendTurn, saveSession } from './session';
import { appendSourcesFooter, collectSourcesFromTool, type SourceRef } from './citations';
import type { AgentEngine, EngineContext, SessionDoneReason } from './engine';
import type { ApiMessage, ContentPart, ToolCall } from './api-types';
import { collectImageRefs, stripDataUrls, isDataUrl } from './tool-images';
import { registerImage, resolveImageRef, listImageIds, seedImageRegistry } from './image-registry';
import { log, warn, error as logError } from '@base/runtime/log';
import { ThrashTracker, NoProgressTracker, toolCallKey } from './resilience';
import {
  DEFAULT_BUDGET,
  budgetVerdict,
  estimatePromptTokens,
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
import { selectTools, DEFAULT_TOOL_SELECT } from './tool-select';
import { getActiveSites, markSiteActive } from '../tools/active-sites';
import { newRunMetrics, renderRunSummary } from './metrics';
import { getMemory, setMemoryContent, renderMemoryBlock } from './memory-store';
import { listSkills, saveSkillByName, getSkillByName, renderSkillsBlock } from '../skills/store';
import { execNotesAction } from './notes-store';
import { FEATURES } from '../config/features';
import {
  saveShortcut,
  makeShortcutId,
  listShortcuts,
  type Shortcut,
} from '../shortcuts/store';
import {
  saveSchedule,
  makeScheduleId,
  listSchedules,
  alarmName,
  alarmInfo,
  cadenceLabel,
  parseCadence,
  type Schedule,
} from '../schedules/store';
import { loadEphemeralAdapter } from '../background/ephemeral-adapter';
import { mapConcurrent } from '../runtime/opencli/utils';
import { chatCompletion, type ChatCompletionResponse } from './chat-completion';
import { truncateStash, safeStringify, sanitizeHistory, parseToolArgs } from './engine-history';
import { handleSpecialistCall } from './specialist-calls';
import { toVisionDataUrl } from './fetch-image';
import {
  VIEW_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL,
  UPDATE_PLAN_TOOL,
  SUBMIT_PLAN_TOOL,
  SUBAGENT_TOOL,
  AWAIT_USER_ACTION_TOOL,
  parseAwaitUserAction,
  NOTE_ADAPTER_TOOL,
  UPDATE_MEMORY_TOOL,
  USE_SKILL_TOOL,
  CREATE_SKILL_TOOL,
  NOTES_TOOL,
  SYNTHESIZE_ADAPTER_TOOL,
  NOTE_FINDING_TOOL,
  ENTER_EXPLORE_TOOL,
  LOAD_ADAPTER_TOOL,
  CREATE_WORKFLOW_TOOL,
  CREATE_SITE_SCRIPT_TOOL,
  LIST_SITE_SCRIPTS_TOOL,
  DELETE_SITE_SCRIPT_TOOL,
  PREVIEW_SITE_SCRIPT_TOOL,
  // CREATE_WORKFLOW_TOOL (above) = save a prompt-recipe workflow (replaced the old
  // rigid pipeline tool + the separate create_shortcut).
  CREATE_SCHEDULE_TOOL,
  EXPLORE_ONLY_TOOLS,
  MAX_VISION_IMAGES_PER_TURN,
  SUBAGENT_PARALLEL_CAP,
  SUBAGENT_FANOUT_MAX,
  MAINLOOP_READ_PARALLEL_CAP,
  specialistSystemNote,
  exploreModeNote,
} from './engine-tools';
import { recordAdapterNote, toHealthId } from '../adapters/adapter-health-store';
import {
  buildSiteScript,
  putSiteScript,
  getSiteScript,
  listSiteScripts,
  deleteSiteScript,
  makeSiteScriptId,
  flagFragileSelectors,
  describeSiteScript,
  type SiteScriptInput,
} from '@base/site-scripts/store';
import {
  refreshSiteScript,
  unregisterSiteScriptById,
  siteScriptsRunnable,
  previewSiteScript,
  dryRunSiteScriptJs,
} from '@base/site-scripts/register';

// Re-exported for importers that referenced these from api-engine before the
// split: explore/synthesize.ts uses chatCompletion; the test suite uses
// ChatCompletionResponse + sanitizeHistory.
export { chatCompletion, sanitizeHistory };
export type { ChatCompletionResponse };

/** Stream the main assistant turn (SSE) for live feedback. Flip off if a
 * provider's endpoint doesn't support streaming / stream_options. */
const STREAM_MAIN_TURN = true;

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
      'No API key configured for the primary model. In "Settings → Model roles", assign the primary model a model that already has a key filled in.',
    );
    return;
  }
  if (needsBaseUrl(primary.provider) && !primary.baseUrl) {
    finish('error', 'No Base URL configured for the primary model.');
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
        ? 'inline(primary model sees them itself)'
        : 'subcall(sub-call to a dedicated model)',
    image: imageProfile ? imageProfile.model : 'none',
  });

  session.status = 'running';
  session.iterations = 0;

  // Re-seed the img_N counter from tokens still in replayed history so a resumed
  // session (SW teardown lost the in-memory registry) never re-mints an id that
  // collides with a historical [img_N] — which would silently resolve view_image
  // to the WRONG image. Must run BEFORE any registerImage below. See §10.26.
  seedImageRegistry(
    session.id,
    (session.apiMessages ?? []).flatMap((m) =>
      typeof m.content === 'string'
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.map((p) => (p.type === 'text' ? p.text : ''))
          : [],
    ),
  );
  // User-attached images are view_image-able later by [img_N] reference too.
  for (const u of ctx.userImages ?? []) registerImage(session.id, u);

  // Persist the user turn for the history drawer, and seed the OpenAI message
  // array (continuing prior turns if any).
  appendTurn(session, { role: 'user', text: ctx.userText, ...ctx.userDisplay, ts: Date.now() });
  // The user's message stays plain TEXT even if it contains image URLs — it's
  // the model's call (via view_image) whether to actually look at them. A URL
  // the user only wants passed along (e.g. "post this image to the comments https://x.jpg")
  // must NOT be force-fed as vision. Fully model-driven; see VISION_SYSTEM_NOTE.
  // sanitizeHistory repairs replayed history (dangling tool_calls, prior-turn
  // image messages flattened to text).
  // User-attached images (e.g. a region screenshot) ARE explicit vision input.
  // Priority (per the config: which model fills the `vision` slot decides who
  // can see images — a multimodal main is assigned to BOTH primary + vision):
  //  1. main model handles images (vision slot == main, `visionInline`) → attach
  //     as image_url so the main model sees them directly.
  //  2. else a separate vision model is configured → describe the image(s) with
  //     it (focused by the user's question) and feed the result to the main
  //     model as text (a text-only main can't read image_url).
  //  3. neither → tell the user (notice) and send text only.
  // sanitizeHistory flattens image content on later turns so it isn't resent.
  // Attach user images inline for a MULTIMODAL primary. Normalize each through
  // toVisionDataUrl (else the provider server-fetches a hotlink/slow URL → Aliyun
  // "download timed out", §10.24) and gate the raw-URL fallback by provider (Kimi
  // rejects URL images → drop rather than 400 the whole request), exactly like the
  // turnImages path — the old sync version did NONE of this. Async (normalization
  // fetches). See §10.35.
  const attachUserImagesInline = async (): Promise<string | ContentPart[]> => {
    const imgs = ctx.userImages ?? [];
    const urlFallbackOk = providerAcceptsHttpImageUrl(cfg);
    const prepared = (
      await Promise.all(
        imgs.map(
          async (u) =>
            (await toVisionDataUrl(u, { signal: ctx.signal })) ?? (urlFallbackOk ? u : null),
        ),
      )
    ).filter((u): u is string => u !== null);
    const dropped = imgs.length - prepared.length;
    // All unfetchable → text only (with a note), never a bad image_url.
    if (!prepared.length) return ctx.userText || '(the attached image(s) could not be read)';
    const note = dropped ? `\n\n(${dropped} more attached image(s) could not be read and were skipped)` : '';
    return [
      ...(ctx.userText || dropped ? [{ type: 'text' as const, text: (ctx.userText ?? '') + note }] : []),
      ...prepared.map(
        (u) => ({ type: 'image_url' as const, image_url: { url: imageUrlForProvider(cfg, u) } }) as const,
      ),
    ];
  };
  let startUserContent: string | ContentPart[] = ctx.userText;
  if (ctx.userImages?.length) {
    if (visionProfile && visionInline) {
      startUserContent = await attachUserImagesInline(); // main model is multimodal
    } else if (visionProfile) {
      try {
        const q = ctx.userText
          ? `The user's question is: "${ctx.userText}". Describe the full content of the image in detail (visible text verbatim where possible, layout, key UI elements/data), making sure to cover the information needed to answer that question.`
          : 'Describe the full content of the image in detail: visible text (verbatim where possible), layout structure, key UI elements/data.';
        const desc = await visionDescribe(visionProfile, ctx.userImages, q, { signal: ctx.signal });
        startUserContent =
          `${ctx.userText}\n\n[Visual understanding of the attached screenshot (vision model ${visionProfile.model}):\n${desc}\n]`.trim();
        ctx.emit({
          type: 'tool_trace',
          trace: {
            id: `vis_${Date.now().toString(36)}`,
            action: 'execute_tool',
            tool: 'view_image',
            args: { images: ctx.userImages.length },
            status: 'completed',
            durationMs: 0,
          },
        });
      } catch (e) {
        // The primary is TEXT-ONLY here (a separate vision model was configured
        // but its describe failed). Do NOT attach image_url to it — that 400s the
        // whole request. Degrade to text + a notice. See §10.35.
        log('api', `vision describe failed; primary is text-only → sending text only: ${String(e)}`);
        ctx.emit({
          type: 'notice',
          level: 'warning',
          text: 'Visual understanding of the attached image failed; continued as plain text only (the primary model can\'t view images directly).',
        });
        startUserContent = ctx.userText;
      }
    } else {
      // No image-capable model configured.
      ctx.emit({
        type: 'notice',
        level: 'warning',
        text: 'The attached image was not sent: no image-capable model is configured. In "Settings → LLM backend → Vision understanding", point the vision slot at your primary model (if it supports images) or at a separate vision model.',
      });
      startUserContent = ctx.userText;
    }
  }
  const messages: ApiMessage[] = [
    ...sanitizeHistory(session.apiMessages ?? []),
    { role: 'user', content: startUserContent },
  ];
  await saveSession(session);

  // Set when a drained steer reads as a "give me a plan to confirm" request
  // (§10.16). Consumed at the top of the execution loop → re-enters planning.
  let pendingReplan = false;

  // External pages the agent actually fetched/navigated to this run — used as a
  // grounded fallback sources list when the final answer cites nothing (§ citations).
  const runSources: SourceRef[] = [];

  /** Fold any queued steering messages (interjections injected mid-run) into the live
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
      if (looksLikeReplanRequest(s)) pendingReplan = true; // §10.16: interjection asks for a plan
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

  // Long-term memory recall: load the user's single memory document once and
  // inject it into the system prompt for this whole run (both planning and
  // execution). Gated off in the product build (FEATURES.memory) — no recall
  // block, no `update_memory` tool (see the tools array below).
  const memoryBlock = FEATURES.memory
    ? renderMemoryBlock(await getMemory().catch(() => ({ enabled: false, content: '', updatedAt: 0 })))
    : '';
  // Skills (progressive disclosure): advertise each skill's name+description so
  // the agent can `use_skill` to load one on demand. Always on (empty when there
  // are no skills). Appended alongside the memory block everywhere it's used.
  const skillsBlock = renderSkillsBlock(await listSkills().catch(() => []));
  const recallBlock = memoryBlock + skillsBlock;
  // Environment note (e.g. disabled func adapters) so the model doesn't
  // silently fall back to generic tools and fake an unavailable capability.
  // The note is now the toggle-aware adapter strategy (engine-driver
  // adapterStrategyNote) — self-contained with its own directive in both the
  // on/off branches, so no generic "unavailable tools" suffix here (it would
  // contradict the toggle-ON case). See adapter-hot-plug §10.39.
  const envNote = ctx.environmentNote ? `\n\n## Runtime environment note\n${ctx.environmentNote}` : '';

  // Explore mode: drive the site once on the dedicated explore tab while the
  // system records a trace; synthesis happens after the run (SW side).
  // A FUNCTION, not a const: enter_explore_mode can upgrade a chat run to
  // explore mid-flight, and the playbook must appear from the next iteration.
  const exploreNote = (): string => (ctx.mode === 'explore' ? exploreModeNote() : '');

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
        provider: cfg.provider,
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
      text: 'Compacted the earlier conversation into a progress summary to free up context space (continuing).',
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

      // Planning exposes ONLY generic perception/navigation tools + submit_plan.
      // Site/installed adapters (xiaohongshu__*, deepseek__*, …) are the actual
      // DELIVERABLES — running one during "research" means doing the task before
      // the user approves a plan (the agent extracted + answered, THEN the card
      // popped, then it re-ran — see docs §10.x). They become callable only in
      // the execution phase. Writes are excluded too (belt-and-suspenders).
      const tools = [
        ...selectTools(
          openAiToolsFromRegistry().filter((t) => {
            const a = lookupAdapter(t.function.name);
            return a?.access !== 'write' && (a?.site ?? 'generic') === 'generic';
          }),
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
          provider: cfg.provider,
          signal: ctx.signal,
          body: {
            model: cfg.model,
            messages: [
              { role: 'system', content: systemPromptPlan() + recallBlock + envNote },
              ...messages,
            ],
            tools,
            tool_choice: 'auto',
            max_tokens: cfg.maxTokens ?? 4096,
          },
        });
      } catch (e) {
        if (ctx.signal.aborted) return 'aborted';
        logError('api', 'planning chatCompletion failed', e);
        planError = e instanceof Error ? e.message : String(e);
        return 'error';
      }
      // Fall back to a char-based estimate when the provider omits `usage` —
      // else compaction + the overflow guard silently disable → context 400 (§10.36).
      lastPromptTokens = resp.usage?.prompt_tokens ?? estimatePromptTokens(messages);
      const choice = resp.choices?.[0];
      if (!choice) {
        planError = 'The LLM returned no choices';
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
            text: 'The model did not submit a confirmable plan and answered directly (the current model/endpoint may not handle forced planning well).',
          });
          return 'answered';
        }
        planNudges++;
        messages.push({
          role: 'user',
          content:
            'In "plan first, then execute" mode, please submit a plan now with submit_plan for the user to confirm — you can write "research X first" as a step in the plan; do not answer directly and do not execute now.',
        });
        appendTurn(session, {
          role: 'user',
          text: '[Planning] Require a confirmable plan first',
          ts: Date.now(),
        });
        session.apiMessages = messages;
        await saveSession(session);
        continue;
      }

      for (const call of toolCalls) {
        if (ctx.signal.aborted) return 'aborted';
        const args = parseToolArgs(call.function.arguments);
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

        // ③ await_user_action → proactive human handoff-resume (login / captcha /
        // a judgment call). Pause via the H9 takeover UI; resume on the user's OK.
        if (call.function.name === 'await_user_action') {
          const { objective, tabId, resume } = parseAwaitUserAction(args);
          if (!objective) {
            await ackTool('await_user_action needs an objective: a user-facing sentence telling them what to do.');
            continue;
          }
          log('api', `await_user_action: ${objective.slice(0, 60)}`, { tabId, resume });
          const resumed = await ctx.awaitUserAction(objective, tabId, resume);
          if (ctx.signal.aborted) return 'aborted';
          await ackTool(
            resumed
              ? `The user completed the operation you requested ("${objective.slice(0, 80)}") and clicked "I'm done". Continue the task — if needed, re-read the page state first (get_interactives / get_html) to confirm the current situation.`
              : `The user did not complete it (clicked skip or timed out). Don't pretend it's done: tell the user truthfully that this step needs them to do it in person, or take a path that needs no human.`,
          );
          continue;
        }

        // submit_plan → approval gate.
        if (call.function.name === 'submit_plan') {
          const goal = typeof args.goal === 'string' ? args.goal : '';
          const proposed = seedPlan(goal, (args as { steps?: unknown[] }).steps ?? [], Date.now());
          log(
            'api',
            `submit_plan intercepted: ${proposed.steps.length} steps → requesting approval`,
          );
          if (proposed.steps.length === 0) {
            await ackTool('The plan is empty; please give a concrete list of steps.');
            emitFinal('failed', { error: 'empty plan' });
            continue;
          }
          // Explicit plan mode: the user chose "plan first, then execute" — ALWAYS show the
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
              `The user approved the plan (${steps.length} steps). Now enter the execution phase, execute step by step per the plan, and update progress with update_plan.`,
            );
            emitFinal('completed', { result: session.plan });
            return 'approved';
          }
          const fb = decision.feedback?.trim();
          if (!fb) {
            await ackTool('The user canceled this plan.');
            emitFinal('completed');
            return 'rejected';
          }
          await ackTool(`The user did not approve; feedback: ${fb}. Please revise accordingly and submit_plan again.`);
          emitFinal('completed');
          continue;
        }

        // Block writes AND site/installed adapters during planning (belt-and-
        // suspenders; also filtered out of the tool list). A site adapter is the
        // deliverable — running it here would do the task before approval. Push
        // it into the plan instead.
        {
          const a = lookupAdapter(call.function.name);
          if (a && (a.access === 'write' || (a.site ?? 'generic') !== 'generic')) {
            await ackTool(
              `The planning phase does not run task tools (${call.function.name} produces results directly). Please write it into the plan's steps and call it in the execution phase after the user approves.`,
            );
            emitFinal('failed', { error: 'task tool blocked in planning' });
            continue;
          }
        }

        // Read-only vision sub-call during planning.
        if (call.function.name === 'view_image' || call.function.name === 'generate_image') {
          const sr = await handleSpecialistCall(call.function.name, args, {
            visionProfile,
            visionInline,
            imageProfile,
            signal: ctx.signal,
            resolveImageRef: (t) => resolveImageRef(session.id, t),
            availableImageIds: () => listImageIds(session.id),
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
        if (r.ok)
          for (const ref of collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN))
            registerImage(session.id, ref);
        const rawResult = stripDataUrls(
          r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `Error: ${r.error ?? '(unknown)'}`,
          (blob) => `[${registerImage(session.id, blob)}]`,
        );
        await ackTool(truncateStash(rawResult).text);
        emitFinal(r.ok ? 'completed' : 'failed', { result: r.result, error: r.error });
      }
    }
    planError = 'The planning phase did not produce an approvable plan within the step limit';
    return 'error';
  }

  // ── Sub-agent (Phase 4): an isolated-context bounded subtask. Its messages
  // never touch the main array; only its final text digest is returned to the
  // main loop. Read-only + serial (the tab/CDP world isn't concurrency-safe).
  const SUBAGENT_MAX_STEPS = 15;
  async function runSubagent(task: string, allowedTools?: string[]): Promise<string> {
    const allow = new Set(allowedTools ?? []);
    // Same catalog narrowing as the main loop (keyed to the SUBTASK text) —
    // sub-agents pay the same per-call schema tokens. An explicit allowed_tools
    // list skips narrowing: the parent already picked the exact set.
    const readTools = openAiToolsFromRegistry().filter((t) => {
      if (lookupAdapter(t.function.name)?.access === 'write') return false; // read-only
      if (allow.size && !allow.has(t.function.name)) return false;
      return true;
    });
    const subTools = allow.size
      ? readTools
      : selectTools(readTools, task, DEFAULT_TOOL_SELECT, getActiveSites()).tools;
    const subMessages: ApiMessage[] = [{ role: 'user', content: task }];
    let last = '';
    for (let i = 0; i < SUBAGENT_MAX_STEPS; i++) {
      if (ctx.signal.aborted) return last || '(sub-agent was interrupted)';
      let resp: ChatCompletionResponse;
      try {
        resp = await complete({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          provider: cfg.provider,
          signal: ctx.signal,
          body: {
            model: cfg.model,
            messages: [{ role: 'system', content: systemPromptSubagent() }, ...subMessages],
            tools: subTools,
            tool_choice: 'auto',
            max_tokens: cfg.maxTokens ?? 4096,
          },
        });
      } catch (e) {
        if (ctx.signal.aborted) return last || '(sub-agent was interrupted)';
        return `Sub-agent call failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      const choice = resp.choices?.[0];
      if (!choice) return last || '(sub-agent returned nothing)';
      const msg = choice.message;
      if (msg.content) last = msg.content;
      const toolCalls = msg.tool_calls;
      subMessages.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls || toolCalls.length === 0) return last.trim() || '(sub-agent reached no conclusion)';
      for (const call of toolCalls) {
        if (ctx.signal.aborted) return last || '(sub-agent was interrupted)';
        const a = parseToolArgs(call.function.arguments);
        // No writes, no recursion inside a sub-agent.
        if (
          call.function.name === 'spawn_subagent' ||
          lookupAdapter(call.function.name)?.access === 'write'
        ) {
          subMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'A sub-agent cannot run this tool (write operations / nested sub-agents are disabled).',
          });
          continue;
        }
        const r = await ctx.executeTool({ tool: call.function.name, args: a });
        // Register images the subagent surfaced too — the MAIN loop's
        // view_image can then reference them by [img_N] from the digest.
        if (r.ok)
          for (const ref of collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN))
            registerImage(session.id, ref);
        const txt = stripDataUrls(
          r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `Error: ${r.error ?? '(unknown)'}`,
          (blob) => `[${registerImage(session.id, blob)}]`,
        );
        // stash-backed: the subagent can read_more the tail (it has the read
        // registry tools) instead of losing it
        subMessages.push({ role: 'tool', tool_call_id: call.id, content: truncateStash(txt).text });
      }
    }
    return last.trim() || '(sub-agent hit the step limit without a clear conclusion)';
  }

  /** Parallel fan-out (parallel-execution v1): run multiple spawn_subagent calls
   * concurrently (capped), then fold their digests into the conversation
   * sequentially — no concurrent mutation of `messages`/`session`. The actual
   * parallelism is in the overlapping runSubagent LLM loops; their tool calls
   * hit the dispatcher concurrently and are made safe by its per-key lock.
   * docs/parallel-execution.md §6. */
  async function runSubagentBatch(calls: ToolCall[]): Promise<void> {
    const outcomes = await mapConcurrent(calls, SUBAGENT_PARALLEL_CAP, async (call) => {
      const a = parseToolArgs(call.function.arguments);
      const task = typeof a.task === 'string' ? a.task.trim() : '';
      const allowed = Array.isArray((a as { allowed_tools?: unknown }).allowed_tools)
        ? (a as { allowed_tools: unknown[] }).allowed_tools.filter(
            (x): x is string => typeof x === 'string',
          )
        : undefined;
      const base = { call, args: a };
      if (!task) return { ...base, ok: false, digest: 'task cannot be empty.', ms: 0 };
      ctx.emit({ type: 'subagent', phase: 'start', id: call.id, task });
      const t0 = Date.now();
      try {
        const digest = await runSubagent(task, allowed);
        const ms = Date.now() - t0;
        ctx.emit({
          type: 'subagent',
          phase: 'done',
          id: call.id,
          task,
          ok: true,
          digestChars: digest.length,
          durationMs: ms,
        });
        return { ...base, ok: true, digest, ms };
      } catch (e) {
        const ms = Date.now() - t0;
        ctx.emit({ type: 'subagent', phase: 'done', id: call.id, task, ok: false, durationMs: ms });
        return {
          ...base,
          ok: false,
          digest: `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`,
          ms,
        };
      }
    });
    // Fold sequentially: push tool results + emit traces + persist once.
    for (const r of outcomes) {
      messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.digest });
      metrics.subagents++;
      const t = {
        id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        action: 'execute_tool' as const,
        tool: 'spawn_subagent',
        args: r.args,
        status: r.ok ? ('completed' as const) : ('failed' as const),
        ...(r.ok ? { result: { digestChars: r.digest.length } } : { error: r.digest }),
        durationMs: r.ms,
      };
      ctx.emit({ type: 'tool_trace', trace: t });
      appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
    }
    session.apiMessages = messages;
    await saveSession(session);
  }

  try {
    if (ctx.mode === 'plan') {
      const planResult = await runPlanningPhase();
      if (planResult === 'aborted') return finish('user_abort');
      if (planResult === 'answered') return finish('no_more_commands');
      if (planResult === 'rejected') {
        ctx.emit({ type: 'notice', level: 'info', text: 'Canceled (the plan was not approved).' });
        return finish('no_more_commands');
      }
      if (planResult === 'error') return finish('error', planError || 'Planning phase failed');
      // 'approved' → fall through to the execution loop with session.plan set.
    }
    // Explore mode is plan-first: guarantee a reviewable plan exists from turn 1
    // (the agent refines it via update_plan as it learns). No approval modal —
    // explore is read-mostly; the real write gate stays the write-confirm. Skip
    // if a plan is already present (a resumed explore session, E4).
    if (ctx.mode === 'explore' && !session.plan) {
      session.plan = seedPlan(
        ctx.userText.slice(0, 80),
        [
          'Find the data source: do the task once on the page, and use list_network / read_network / get_html to find which endpoint or selector the data comes from',
          'Synthesize the adapter and verify it with an automatic test run (synthesize_adapter)',
          'On failure, fix per the error; on success, explore other related operations on the same site as needed',
        ],
        Date.now(),
      );
      ctx.emit({ type: 'plan_updated', plan: session.plan });
      await saveSession(session);
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
        ctx.emit({ type: 'notice', level: 'info', text: 'Per your mid-run request, re-planning and asking you to confirm…' });
        const replan = await runPlanningPhase();
        if (replan === 'aborted') return finish('user_abort');
        if (replan === 'error') return finish('error', planError || 'Re-planning failed');
        if (replan === 'rejected') {
          ctx.emit({ type: 'notice', level: 'info', text: 'You canceled the new plan; keeping the original plan and continuing.' });
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
            ? `Reached this run's step limit (${budget.maxSteps} steps)`
            : 'The context is close to the model limit';
        log('api', `session=${session.id} checkpoint`, {
          reason: verdict.reason,
          iter,
          lastPromptTokens,
        });
        ctx.emit({
          type: 'notice',
          level: 'info',
          text: `${why}; saving progress here for now. Send "continue" to finish it (context is preserved).`,
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
      // Catalog narrowing (tool-select v2): sites named in the task text or
      // session-active keep full schemas; the rest collapse into a one-line
      // digest injected into the system prompt below. Text-matched sites are
      // persisted as active so follow-up turns ("continue") keep them expanded.
      const selection = selectTools(
        openAiToolsFromRegistry(),
        ctx.userText,
        DEFAULT_TOOL_SELECT,
        getActiveSites(),
      );
      selection.matchedSites.forEach(markSiteActive);
      const selected = selection.tools;
      const catalogNote = selection.digest
        ? `\n\n## Collapsed site adapters (installed, use as needed)\nTo save context, the site tools below are shown without full parameter descriptions, but **they are all registered and directly callable** (tool name is site__name; parameter names are in parentheses, a trailing ? means optional):\n${selection.digest}\nWhen you need a site tool's full description / more candidates, use find_adapters to search that site, and its full definition will expand automatically next turn.`
        : '';
      const baseTools =
        ctx.mode === 'explore'
          ? selected
          : selected.filter((t) => !EXPLORE_ONLY_TOOLS.has(t.function.name));
      const tools = [
        ...baseTools,
        UPDATE_PLAN_TOOL,
        // Auto-plan: in the default mode the agent MAY propose a plan for approval
        // when it judges the task complex/uncertain (offered until one is
        // approved). /plan mode already ran the forced planning phase first.
        ...(ctx.mode !== 'explore' && !session.plan?.approved ? [SUBMIT_PLAN_TOOL] : []),
        SUBAGENT_TOOL,
        AWAIT_USER_ACTION_TOOL, // ③ proactive human handoff (login/captcha/judgment)
        NOTE_ADAPTER_TOOL, // ⑩ per-adapter experience notes
        // My Memory / My Notes — hidden in the product build (FEATURES); omitting
        // the tools is the prompt edit (their descriptions are the only place
        // these features are advertised to the model).
        ...(FEATURES.memory ? [UPDATE_MEMORY_TOOL] : []),
        ...(FEATURES.notes ? [NOTES_TOOL] : []),
        // Skills (progressive disclosure): use_skill loads a body on demand, always available (the prompt block is empty when there are no skills).
        USE_SKILL_TOOL,
        ...(ctx.mode === 'explore'
          ? [SYNTHESIZE_ADAPTER_TOOL, NOTE_FINDING_TOOL]
          : [
              // Escape hatch into explore mode (user-confirmed) when the ask
              // needs adapter synthesis/repair — see engine-tools.ts.
              ...(ctx.enterExploreMode ? [ENTER_EXPLORE_TOOL] : []),
              LOAD_ADAPTER_TOOL,
              CREATE_WORKFLOW_TOOL, // save a reusable prompt recipe (workflow)
              CREATE_SKILL_TOOL, // save a reusable skill (a manual the agent loads on demand)
              CREATE_SCHEDULE_TOOL, // scheduled task (run a workflow / prompt on a schedule)
              CREATE_SITE_SCRIPT_TOOL, // persistent site script / ad removal
              LIST_SITE_SCRIPTS_TOOL,
              DELETE_SITE_SCRIPT_TOOL,
              PREVIEW_SITE_SCRIPT_TOOL,
            ]),
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

      // Site findings load asynchronously after the first navigation resolves the
      // site, so pull them fresh each turn (like exploreNote(), which must also
      // reflect a mid-run chat→explore upgrade).
      const exploreFindings =
        ctx.mode === 'explore' ? (getActiveExploreSession()?.findingsNote() ?? '') : '';

      let lastStreamLen = 0;
      let resp: ChatCompletionResponse;
      try {
        resp = await complete({
          apiKey: cfg.apiKey,
          baseUrl: cfg.baseUrl,
          provider: cfg.provider,
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
                  specialistSystemNote({
                    vision: hasVisionTool,
                    visionInline,
                    image: hasImageTool,
                  }) +
                  renderBudgetNote(iter, budget) +
                  (session.plan
                    ? renderPlanBlock(session.plan)
                    : '\n\nFor a multi-step task (≥3 steps), consider using update_plan to lay out a todo list before you start.') +
                  recallBlock +
                  envNote +
                  catalogNote +
                  exploreNote() +
                  exploreFindings,
              },
              ...messages,
            ],
            tools,
            tool_choice: 'auto',
            max_tokens: cfg.maxTokens ?? 4096,
          },
        });
      } catch (e) {
        if (ctx.signal.aborted) return finish('user_abort');
        logError('api', 'chatCompletion failed', e);
        return finish('error', e instanceof Error ? e.message : String(e));
      }

      // Track real prompt-token usage (free, from the provider) for the
      // budget gate + compaction trigger (slice 3).
      // Fall back to a char-based estimate when the provider omits `usage` —
      // else compaction + the overflow guard silently disable → context 400 (§10.36).
      lastPromptTokens = resp.usage?.prompt_tokens ?? estimatePromptTokens(messages);
      metrics.promptTokens = lastPromptTokens;
      metrics.completionTokens += resp.usage?.completion_tokens ?? 0;
      ctx.emit({
        type: 'run_stats',
        step: iter + 1,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
      });

      const choice = resp.choices?.[0];
      if (!choice) return finish('error', 'The LLM returned no choices');
      // Output hit the max_tokens ceiling — the PROVIDER cut it mid-stream. The
      // user must know the content may be incomplete (and where the knob is).
      if (choice.finish_reason === 'length') {
        ctx.emit({
          type: 'notice',
          level: 'warning',
          text: `This output hit the max_tokens ceiling (${cfg.maxTokens ?? 4096}) and was truncated, so the content may be incomplete — you can raise the "output limit" for this model in "LLM configuration"`,
        });
      }
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

      // Grounded fallback: on the FINAL answer (no tool calls), if the model
      // cited no sources but we navigated/fetched external pages this run, append
      // a sources list so an externally-sourced answer always shows where it came
      // from. Only the displayed/persisted turn is augmented — the LLM history
      // (messages, pushed above with the raw content) stays the model's own text.
      const isFinalTurn = !toolCalls || toolCalls.length === 0;
      const displayText = isFinalTurn ? appendSourcesFooter(text, runSources) : text;

      appendTurn(session, {
        role: 'assistant',
        cleanedText: displayText,
        reasoningText: thinking,
        commands: [],
        iteration: iter,
        ts: Date.now(),
      });
      ctx.emit({
        type: 'assistant_turn',
        iteration: iter,
        cleanedText: displayText,
        reasoningText: thinking,
        commands: [],
      });
      ctx.emit({ type: 'iteration_progress', iteration: iter, iterationId, phase: 'completed' });
      session.apiMessages = messages;
      await saveSession(session);

      if (!toolCalls || toolCalls.length === 0) {
        // Reflect & re-plan: on a finish attempt, do ONE self-check. The
        // unsettled-steps reconcile applies to ANY plan — chat-mode update_plan
        // todos included: the model routinely marks the last step in_progress,
        // answers, and leaves the user-visible checklist lying "organizing…" forever
        // (real-session finding, §4.3.0c). The goal self-check below stays
        // plan-mode-only (approved) — it's a heavier loop chat todos don't need.
        // Once per run so it can't loop forever.
        if (!reflectedOnce && session.plan?.steps.length) {
          const goalLine = session.plan.goal ? `Goal: ${session.plan.goal}\n` : '';
          const unsettled = session.plan.steps.filter((s) => !isTerminal(s.status));
          if (unsettled.length) {
            reflectedOnce = true;
            // Finish-time reconcile (§10.15): the model is wrapping up but left
            // steps unsettled. Force ONE truthful update_plan so the checklist
            // never lies — each step ends as completed / skipped / failed (with a
            // reason), not silently left pending. We do NOT auto-stamp them
            // completed: that would fake success. Truthful > clean.
            const pending = unsettled.map((s) => `- ${s.title}`).join('\n');
            messages.push({
              role: 'user',
              content:
                `[Reconcile] ${goalLine}You're about to finish, but these plan steps still have no outcome marked:\n${pending}\n` +
                'Use update_plan to send back the [complete] step list, truthfully updating every step to a terminal state: genuinely finished → completed; deliberately skipped (not needed / precondition unmet) → skipped; attempted but didn\'t work out → failed. For skipped/failed, write a one-line reason in activeForm. Do not mark undone steps as completed, and do not leave any unmarked.',
            });
            appendTurn(session, {
              role: 'user',
              text: '[Reconcile] Truthfully mark the outcome of every plan step',
              ts: Date.now(),
            });
            ctx.emit({
              type: 'notice',
              level: 'info',
              text: 'Having the model truthfully reconcile each plan step\'s outcome (completed/skipped/failed)…',
            });
            session.apiMessages = messages;
            await saveSession(session);
            continue;
          }
          if (session.plan.approved) {
            // Every step is already in a terminal state → one goal self-check
            // (plan mode only — an approved plan is a promise to the user).
            reflectedOnce = true;
            messages.push({
              role: 'user',
              content: `[Self-check] ${goalLine}Every step of the plan now has an outcome. Do one final self-check: did you actually achieve the goal above? Any omissions, quality gaps, or things worth strengthening? If more is needed, add steps with update_plan and continue; if it's all correct, give your [complete, detailed] final reply in a single message with [no tool calls at all] (don't give just a one-line summary).`,
            });
            appendTurn(session, { role: 'user', text: '[Self-check] Review against the plan', ts: Date.now() });
            ctx.emit({
              type: 'notice',
              level: 'info',
              text: 'All plan steps are settled; having the model self-check once against the goal…',
            });
            session.apiMessages = messages;
            await saveSession(session);
            continue;
          }
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

      // Parallel fan-out (parallel-execution v1/v2): if the model emitted
      // MULTIPLE spawn_subagent calls this turn, run them concurrently here
      // (capped per-turn) and skip them in the sequential loop below. A single
      // subagent stays on the inline path.
      const allSubCalls = toolCalls.filter((c) => c.function.name === 'spawn_subagent');
      const didFanOut = allSubCalls.length > 1;
      if (didFanOut) {
        if (ctx.signal.aborted) return finish('user_abort');
        const accepted = allSubCalls.slice(0, SUBAGENT_FANOUT_MAX);
        const deferred = allSubCalls.slice(SUBAGENT_FANOUT_MAX);
        await runSubagentBatch(accepted);
        // Answer the over-cap calls too (tool_calls must stay paired 1:1) and
        // tell the model to re-issue them next turn.
        for (const call of deferred) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `The per-turn parallel sub-agent cap is ${SUBAGENT_FANOUT_MAX}; this one was not run — please re-issue it next turn.`,
          });
        }
        if (deferred.length) {
          session.apiMessages = messages;
          await saveSession(session);
        }
        anyToolSuccess = true;
      }

      // Parallel main-loop reads (parallel-execution v3 step 2): independent READ
      // adapter calls in this turn run concurrently. tool_calls in one assistant
      // message are issued without seeing each other's results — independent by
      // construction — so overlapping is safe; the dispatcher's per-site tab pool
      // makes same-site concurrency safe. Writes + intercepted tools (plan /
      // workflow / subagent / specialist / …) stay on the sequential path below.
      const parallelReadCalls = toolCalls.filter((c) => {
        if (didFanOut && c.function.name === 'spawn_subagent') return false;
        const a = lookupAdapter(c.function.name);
        return !!a && a.access !== 'write';
      });
      const didParallelReads = parallelReadCalls.length > 1;
      const parallelReadIds = new Set<string>(
        didParallelReads ? parallelReadCalls.map((c) => c.id) : [],
      );
      if (didParallelReads) {
        if (ctx.signal.aborted) return finish('user_abort');
        const outcomes = await mapConcurrent(
          parallelReadCalls,
          MAINLOOP_READ_PARALLEL_CAP,
          async (call) => {
            const a = parseToolArgs(call.function.arguments);
            const traceId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            const started = {
              id: traceId,
              action: 'execute_tool' as const,
              tool: call.function.name,
              args: a,
              status: 'started' as const,
            };
            ctx.emit({ type: 'tool_trace', trace: started });
            appendTurn(session, { role: 'tool_trace', trace: started, ts: Date.now() });
            const r = await ctx.executeTool({ tool: call.function.name, args: a });
            return { call, args: a, traceId, r };
          },
        );
        if (ctx.signal.aborted) return finish('user_abort');
        // Fold sequentially (no concurrent mutation of messages/session): push
        // each tool result + completed trace in call order, persist once. Same
        // shape as the sequential executeTool path below.
        for (const { call, args: a, traceId, r } of outcomes) {
          metrics.toolCalls++;
          if (r.ok) anyToolSuccess = true;
          else metrics.toolErrors++;
          const images =
            visionInline && r.ok
              ? collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN).filter(isDataUrl)
              : [];
          // Register ALL surfaced image refs (regardless of visionInline) so a
          // text-only primary can view_image them by [img_N] (§10.25).
          if (r.ok)
            for (const ref of collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN))
              registerImage(session.id, ref);
          if (r.ok) collectSourcesFromTool(call.function.name, r.result, runSources);
          let rawResult = r.ok
            ? typeof r.result === 'string'
              ? r.result
              : safeStringify(r.result)
            : `Error: ${r.error ?? '(unknown)'}`;
          rawResult = stripDataUrls(rawResult, (blob) => `[${registerImage(session.id, blob)}]`);
          // Oversize results: cut for the prompt, stash the full text so the
          // model can page the rest via read_more — and TELL THE USER a cut
          // happened (they could never see it before).
          const { text: fedResult, truncated: cutChars } = truncateStash(rawResult);
          messages.push({ role: 'tool', tool_call_id: call.id, content: fedResult });
          if (cutChars > 0) {
            ctx.emit({
              type: 'notice',
              level: 'info',
              text: `The "${call.function.name}" result was oversized; truncated ${cutChars.toLocaleString()} characters (kept 64k) — the model can read on in chunks with read_more; take note if the final conclusion depends on the truncated data`,
            });
          }
          if (images.length) turnImages.push(...images);
          const traceFinal = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args: a,
            status: (r.ok ? 'completed' : 'failed') as 'completed' | 'failed',
            result: r.result,
            error: r.error,
            durationMs: r.durationMs,
          };
          ctx.emit({ type: 'tool_trace', trace: traceFinal });
          appendTurn(session, { role: 'tool_trace', trace: traceFinal, ts: Date.now() });
          const b = thrash.record(toolCallKey(call.function.name, a), r.ok);
          if (b) breaker = b;
        }
        session.apiMessages = messages;
        await saveSession(session);
      }

      for (const call of toolCalls) {
        if (ctx.signal.aborted) return finish('user_abort');
        if (didFanOut && call.function.name === 'spawn_subagent') continue;
        if (parallelReadIds.has(call.id)) continue; // handled in the parallel pre-pass

        const args = parseToolArgs(call.function.arguments);

        // Auto-plan: the agent decided this task warrants a reviewable plan.
        // Pop the approval card NOW (before any deliverable runs); on approve we
        // keep executing this same loop with the approved plan in context.
        if (call.function.name === 'submit_plan') {
          const goal = typeof args.goal === 'string' ? args.goal : '';
          const proposed = seedPlan(goal, (args as { steps?: unknown[] }).steps ?? [], Date.now());
          const ack = async (content: string): Promise<void> => {
            messages.push({ role: 'tool', tool_call_id: call.id, content });
            session.apiMessages = messages;
            await saveSession(session);
          };
          if (proposed.steps.length === 0) {
            await ack('The plan is empty. If the task is simple, just execute — no need for submit_plan; if you want a plan, give concrete steps.');
            continue;
          }
          const decision = await ctx.requestPlanDecision(proposed);
          if (ctx.signal.aborted) return finish('user_abort');
          if (decision.decision === 'approve') {
            const steps =
              decision.editedSteps && decision.editedSteps.length
                ? seedPlan(goal, decision.editedSteps, Date.now()).steps
                : proposed.steps;
            session.plan = { goal: proposed.goal, steps, updatedAt: Date.now(), approved: true };
            ctx.emit({ type: 'plan_updated', plan: session.plan });
            await ack(`The user approved the plan (${steps.length} steps). Execute per the plan and update progress with update_plan.`);
            continue;
          }
          const fb = decision.feedback?.trim();
          await ack(
            fb
              ? `The user did not approve; feedback: ${fb}. Revise accordingly and submit_plan again, or just adjust execution per the feedback.`
              : 'The user canceled this plan. Stop and ask the user what to do next; don\'t continue on your own.',
          );
          continue;
        }

        // ③ await_user_action → proactive human handoff-resume (login / captcha /
        // judgment). Intercepted here too (this is the main execution loop —
        // handling it only in the earlier loop let it fall through to the
        // dispatcher → "tool not found"). Pause via H9 takeover; resume on OK.
        if (call.function.name === 'await_user_action') {
          const ack = async (content: string): Promise<void> => {
            messages.push({ role: 'tool', tool_call_id: call.id, content });
            session.apiMessages = messages;
            await saveSession(session);
          };
          const { objective, tabId, resume } = parseAwaitUserAction(args);
          if (!objective) {
            await ack('await_user_action needs an objective: a user-facing sentence telling them what to do.');
            continue;
          }
          log('api', `await_user_action: ${objective.slice(0, 60)}`, { tabId, resume });
          const resumed = await ctx.awaitUserAction(objective, tabId, resume);
          if (ctx.signal.aborted) return finish('user_abort');
          await ack(
            resumed
              ? `The user completed the operation you requested ("${objective.slice(0, 80)}") and clicked "I'm done". Continue the task — if needed, re-read the page state first (get_interactives / get_html) to confirm the current situation.`
              : `The user did not complete it (clicked skip or timed out). Don't pretend it's done: tell the user truthfully that this step needs them to do it in person, or take a path that needs no human.`,
          );
          continue;
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
            content: `Updated the todo list (${prog.completed}/${prog.total} done).`,
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
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'task cannot be empty.' });
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
          ctx.emit({ type: 'subagent', phase: 'start', id: call.id, task });
          const subStart = Date.now();
          const digest = await runSubagent(task, allowed);
          metrics.subagents++;
          messages.push({ role: 'tool', tool_call_id: call.id, content: digest });
          const subMs = Date.now() - subStart;
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            result: { digestChars: digest.length },
            durationMs: subMs,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          ctx.emit({
            type: 'subagent',
            phase: 'done',
            id: call.id,
            task,
            ok: true,
            digestChars: digest.length,
            durationMs: subMs,
          });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // update_memory (long-term memory): replace the single memory document
        // with the agent's integrated new version, ack the model.
        if (call.function.name === 'update_memory') {
          const content = typeof args.content === 'string' ? args.content : '';
          const cur = await getMemory();
          let resultText: string;
          if (!cur.enabled) {
            resultText = 'The user turned off long-term memory; nothing was written.';
          } else if (!content.trim()) {
            resultText = 'update_memory needs content (the integrated, complete memory document).';
          } else {
            await setMemoryContent(content);
            resultText = 'Long-term memory updated (the user can view / edit it on the "My Memory" page).';
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // use_skill (progressive disclosure): load ONE skill's full body so the
        // agent can follow it. Advertised name+description live in the prompt.
        if (call.function.name === 'use_skill') {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          const skill = name ? await getSkillByName(name) : null;
          let resultText: string;
          if (!name) {
            resultText = 'use_skill needs a name (the skill name to load).';
          } else if (!skill) {
            const all = (await listSkills()).map((s) => s.name).join(' / ');
            resultText = `There is no skill named "${name}". Available skills: ${all || '(none)'}`;
          } else {
            resultText = `Instructions for skill "${skill.name}" (follow them; ⟦tool:..⟧ in the body names the tool/adapter/workflow you should call):\n\n${skill.body}`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: (skill ? 'completed' : 'failed') as 'completed' | 'failed',
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // create_skill: author/overwrite a single-file markdown skill (upsert by
        // name). Non-explore.
        if (call.function.name === 'create_skill') {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          const description = typeof args.description === 'string' ? args.description.trim() : '';
          const body = typeof args.body === 'string' ? args.body.trim() : '';
          let resultText: string;
          if (!name || !body) {
            resultText = 'create_skill needs a name and body (the skill body).';
          } else {
            const existed = await getSkillByName(name);
            await saveSkillByName({ name, description, body });
            resultText = `Skill "${name}" ${existed ? 'updated' : 'created'}. The user can view / edit it on the "Skills" page; when relevant you'll see it under "Available skills" and load it with use_skill.`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // notes (notebook): intercepted CRUD on the user's markdown notes. Not
        // injected into context — used only on the user's explicit ask.
        if (call.function.name === 'notes') {
          const r = await execNotesAction(args);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: r.ok ? JSON.stringify(r.result) : `Note operation failed: ${r.error}`,
          });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: (r.ok ? 'completed' : 'failed') as 'completed' | 'failed',
            result: r.ok ? r.result : undefined,
            error: r.ok ? undefined : r.error,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        if (call.function.name === 'load_adapter') {
          const site = typeof args.site === 'string' ? args.site : '';
          const name = typeof args.name === 'string' ? args.name : '';
          const r = await loadEphemeralAdapter(site, name);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: r.ok
              ? `Temporarily loaded tool ${r.tool} (not installed; lost on SW restart). Parameter schema: ${JSON.stringify(r.args ?? [])}. You can now call ${r.tool} directly.`
              : `Load failed: ${r.error}`,
          });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: (r.ok ? 'completed' : 'failed') as 'completed' | 'failed',
            result: r.ok ? r : undefined,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // enter_explore_mode: the agent asks to upgrade this chat run into
        // explore (the ask needs adapter synthesis/repair). The driver pops the
        // confirm card, starts/resumes the explore session and flips ctx.mode —
        // tools + prompt notes are re-read every iteration, so from the next
        // turn the agent has the full explore toolkit. Never dispatched.
        if (call.function.name === 'enter_explore_mode') {
          const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
          let resultText: string;
          if (!ctx.enterExploreMode) {
            resultText = 'This session does not support switching to Explore mode.';
          } else {
            try {
              resultText = await ctx.enterExploreMode(reason);
            } catch (e) {
              resultText = `Failed to switch to Explore mode: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          if (ctx.signal.aborted) return finish('user_abort');
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            result: { mode: ctx.mode },
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // synthesize_adapter (Explore v2): intercepted. The SW synthesizes the
        // current trace slice into a deterministic adapter, streams it to the
        // Explore-results card, session-registers + smoke-tests it, and hands back a
        // concise outcome so the agent repairs-and-retries or moves on. Never
        // dispatched. No-op-with-message outside explore mode.
        if (call.function.name === 'synthesize_adapter') {
          const aName = typeof args.name === 'string' ? args.name.trim() : undefined;
          const aNotes = typeof args.notes === 'string' ? args.notes.trim() : undefined;
          let resultText: string;
          if (!ctx.synthesizeExploreAdapter) {
            resultText = 'synthesize_adapter is only available in Explore mode.';
          } else {
            try {
              resultText = await ctx.synthesizeExploreAdapter({ name: aName, notes: aNotes });
            } catch (e) {
              resultText = `Synthesis failed: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            result: { synthesized: true },
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          anyToolSuccess = true;
          continue;
        }

        // note_finding (Explore v2): record one reusable site fact. Intercepted;
        // persisted to site memory by the SW. No-op outside explore mode.
        if (call.function.name === 'note_finding') {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          const kind = typeof args.kind === 'string' ? args.kind : 'fact';
          let resultText: string;
          if (!text) {
            resultText = 'text cannot be empty.';
          } else if (!ctx.noteFinding) {
            resultText = 'note_finding is only available in Explore mode.';
          } else {
            ctx.noteFinding({ text, kind });
            resultText = `Finding recorded: ${text}`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // ⑩ note_adapter_experience → per-adapter experience note (site/name key).
        if (call.function.name === 'note_adapter_experience') {
          const toolName = typeof args.tool === 'string' ? args.tool.trim() : '';
          const note = typeof args.note === 'string' ? args.note.trim() : '';
          const id = toHealthId(toolName);
          let resultText;
          if (!id) {
            resultText =
              'note_adapter_experience only records for a **site adapter** — pass the full tool name (e.g. zhihu__search); generic tools are not recorded.';
          } else if (!note) {
            resultText = 'note cannot be empty.';
          } else {
            await recordAdapterNote(id, note);
            resultText = `Recorded experience for ${id}: ${note} (surfaced automatically the next time this adapter fails).`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // persistent site scripts (ad removal/enhancement) — create / list / delete. Cosmetic-only via the
        // tool (hide_selectors → display:none); raw css/js are store-supported but
        // manual-UI only (higher risk). Persistent, visible + revocable in the side panel.
        if (
          call.function.name === 'create_site_script' ||
          call.function.name === 'list_site_scripts' ||
          call.function.name === 'delete_site_script' ||
          call.function.name === 'preview_site_script'
        ) {
          let resultText: string;
          if (call.function.name === 'create_site_script') {
            try {
              const matches = (Array.isArray(args.matches) ? args.matches : []).filter(
                (m): m is string => typeof m === 'string',
              );
              const hideSelectors = (
                Array.isArray(args.hide_selectors) ? args.hide_selectors : []
              ).filter((s): s is string => typeof s === 'string');
              const css = typeof args.css === 'string' && args.css.trim() ? args.css.trim() : undefined;
              const js = typeof args.js === 'string' && args.js.trim() ? args.js.trim() : undefined;
              const llmAccess = args.llm_access === true && !!js;
              const runAt = typeof args.run_at === 'string' ? args.run_at : undefined;
              const label = typeof args.label === 'string' ? args.label.trim() : undefined;
              const input: SiteScriptInput = {
                ...(label ? { label } : {}),
                matches,
                hideSelectors,
                ...(css ? { css } : {}),
                ...(js ? { js } : {}),
                ...(llmAccess ? { llmAccess: true } : {}),
                ...(runAt ? { runAt } : {}),
                origin: { type: 'agent' },
              };
              // Upsert by label so re-creating with the same name updates in place.
              const existing = label
                ? (await listSiteScripts()).find((s) => s.label === label)
                : undefined;
              const s = buildSiteScript(input, existing?.id ?? makeSiteScriptId(), Date.now());
              // v2 safety: css/js are powerful (restyle / arbitrary JS on every
              // visit) → confirm with the user. hide-only stays no-confirm.
              let declined = false;
              if ((s.css || s.js) && ctx.confirmWrite) {
                const ok = await ctx.confirmWrite({
                  tool: 'create_site_script',
                  args: {
                    matches: s.matches,
                    ...(s.css ? { css: s.css } : {}),
                    ...(s.js ? { js: s.js } : {}),
                    ...(s.llmAccess ? { llm_access: true } : {}),
                  },
                  description: `The persistent site script "${s.label}" will auto-inject${s.css ? ' CSS' : ''}${s.js ? ' JS' : ''} on every visit to ${s.matches.join(
                    ', ',
                  )}${
                    s.llmAccess
                      ? ', and let it call your configured AI model from the page (rate-limited: 30/5 min, 300/day, incurs model usage)'
                      : ''
                  }. ${describeSiteScript(s)}`,
                });
                declined = !ok;
              }
              if (declined) {
                resultText = `The user canceled creating (a site script with${s.js ? ' JS' : ' CSS'} injection). Don't force it — switch to hide_selectors only to hide elements, or tell the user truthfully that this step needs their consent.`;
              } else {
                await putSiteScript(s);
                await refreshSiteScript(s.id);
                const toggleWarn = siteScriptsRunnable()
                  ? ''
                  : ' ⚠️ But Chrome\'s "Allow user scripts" toggle is off, so the rule is not in effect yet (it takes effect automatically once enabled in chrome://extensions).';
                const fragile = flagFragileSelectors(s.hideSelectors);
                const fragileWarn = fragile.length
                  ? ` ⚠️ These selectors look like random hashes and break easily when the site changes: ${fragile.join(
                      ', ',
                    )} — try to use semantic/aria/data-* anchors instead.`
                  : '';
                const kinds = [
                  s.hideSelectors?.length ? `hide ${s.hideSelectors.length} selector(s)` : '',
                  s.css ? 'inject CSS' : '',
                  s.js ? 'inject JS' : '',
                  s.llmAccess ? 'in-page LLM (__webLLM)' : '',
                ]
                  .filter(Boolean)
                  .join(' + ');
                resultText =
                  `${existing ? 'Updated' : 'Created'} and enabled site script "${s.label}": matches ${s.matches.join(
                    ', ',
                  )}, ${kinds || '(empty)'}. The user can view/disable/delete it in the side panel's "Site scripts". ${toggleWarn}${fragileWarn}`;
              }
            } catch (e) {
              resultText = `Failed to create site script: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else if (call.function.name === 'list_site_scripts') {
            const rows = await listSiteScripts();
            resultText = rows.length
              ? 'Persistent site scripts:\n' +
                rows
                  .map(
                    (s) =>
                      `- [${s.id}] ${s.label} · ${s.matches.join(', ')} · hide ${
                        s.hideSelectors?.length ?? 0
                      }${s.css ? ' +CSS' : ''}${s.js ? ' +JS' : ''} · ${s.enabled ? 'enabled' : 'disabled'}`,
                  )
                  .join('\n')
              : 'No persistent site scripts yet. Use create_site_script to remove ads/noise on a site.';
          } else if (call.function.name === 'delete_site_script') {
            const id = typeof args.id === 'string' ? args.id.trim() : '';
            if (!id) {
              resultText = 'delete_site_script needs an id (get it first with list_site_scripts).';
            } else {
              const s = await getSiteScript(id);
              await unregisterSiteScriptById(id);
              await deleteSiteScript(id);
              resultText = s
                ? `Deleted site script "${s.label}" and unregistered its persistent injection.`
                : `Site script ${id} not found (it may already be deleted).`;
            }
          } else {
            // preview_site_script — temporary WYSIWYG preview + JS dry-run.
            const tabId = typeof args.tab_id === 'number' ? args.tab_id : undefined;
            const hideSelectors = (
              Array.isArray(args.hide_selectors) ? args.hide_selectors : []
            ).filter((s): s is string => typeof s === 'string');
            const css = typeof args.css === 'string' && args.css.trim() ? args.css.trim() : undefined;
            const highlight = args.highlight === true;
            const js = typeof args.js === 'string' && args.js.trim() ? args.js.trim() : undefined;
            if (typeof tabId !== 'number') {
              resultText = 'preview_site_script needs a tab_id (open the target site first with open_url).';
            } else if (!hideSelectors.length && !css && !js) {
              resultText = 'preview_site_script needs hide_selectors / css (preview hiding) or js (dry-run).';
            } else {
              const parts: string[] = [];
              if (hideSelectors.length || css) {
                const r = await previewSiteScript(tabId, hideSelectors, css, highlight);
                parts.push(
                  `Temporarily ${highlight ? 'highlighted (red outline on matched elements, not hidden)' : 'previewed hiding'} in tab ${tabId} (lost on refresh): the selectors currently match ${
                    r.matched
                  } element(s)${r.matched === 0 ? ' (0 = no match, try a more precise selector)' : ''}.`,
                );
              }
              if (js) {
                // JS dry-run: run once in the USER_SCRIPT world, surface
                // console / error / return value so the agent debugs the logic
                // BEFORE committing (the fix for the blind create→reload loop).
                const d = await dryRunSiteScriptJs(tabId, js);
                if (!d.ran) {
                  parts.push(`JS dry-run did not execute: ${d.error ?? 'unknown reason'}`);
                } else {
                  const rv =
                    d.returnValue === undefined
                      ? '(no return value)'
                      : JSON.stringify(d.returnValue).slice(0, 1500);
                  const logs = d.logs.length ? d.logs.slice(0, 40).join('\n  ') : '(none)';
                  parts.push(
                    `JS dry-run (USER_SCRIPT world, not persisted, no __webLLM):\n` +
                      `- thrown error: ${d.error ?? 'none'}\n` +
                      `- return value: ${rv}\n` +
                      `- console:\n  ${logs}\n` +
                      `Use this to validate the logic/selectors/URL guard before solidifying with create_site_script; don't blindly "solidify → reload → wait".`,
                  );
                }
              }
              resultText = parts.join('\n\n');
            }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // workflow (a reusable prompt recipe, stored in the shortcut store). The
        // agent tool is `create_workflow`; upsert by label so re-saving the same
        // name modifies it in place. Non-explore.
        if (call.function.name === 'create_workflow') {
          const label = typeof args.label === 'string' ? args.label.trim() : '';
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          let resultText: string;
          if (!label || !text) {
            resultText = 'create_workflow needs a label and text (the workflow prompt recipe).';
          } else {
            // Upsert by label among prompt recipes: re-saving the same name
            // UPDATES it (keeps id) so the agent can "modify" one in place.
            const existing = (await listShortcuts()).find(
              (s) => s.kind === 'prompt' && s.label === label,
            );
            await saveShortcut({
              id: existing?.id ?? makeShortcutId(),
              label,
              kind: 'prompt',
              text,
            });
            resultText = `Workflow "${label}" ${existing ? 'updated' : 'created'}. The user can view / edit / run it on the "Workflows" page, invoke it with / in the input box, or run it on a schedule via a scheduled task.`;
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
            durationMs: 0,
          };
          ctx.emit({ type: 'tool_trace', trace: t });
          appendTurn(session, { role: 'tool_trace', trace: t, ts: Date.now() });
          session.apiMessages = messages;
          await saveSession(session);
          continue;
        }

        // scheduled task (H3) — schedule a saved workflow (by name → shortcutId, resolved
        // to its current text at run time) OR an inline prompt on a cadence. Both
        // run as a full agent session. Validate, upsert by label, register the
        // chrome.alarm inline (importing schedule-runner would cycle through
        // engine-driver → api-engine). Non-explore only.
        if (call.function.name === 'create_schedule') {
          const label = typeof args.label === 'string' ? args.label.trim() : '';
          const shortcutName =
            typeof args.shortcut_name === 'string' ? args.shortcut_name.trim() : '';
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
          const note = typeof args.note === 'string' ? args.note.trim() : '';
          const now = Date.now();
          const parsed = parseCadence(args.cadence, now);
          let resultText: string;
          if (!label) {
            resultText = 'create_schedule needs a label.';
          } else if (!shortcutName && !prompt) {
            resultText =
              'create_schedule needs either shortcut_name (run a saved workflow on a schedule) or prompt (run a set of instructions on a schedule) — pick one.';
          } else if ('error' in parsed) {
            resultText = `create_schedule's cadence is invalid: ${parsed.error}`;
          } else {
            // Resolve a workflow (prompt recipe) reference to its id/label.
            let sc: Shortcut | undefined;
            if (shortcutName) {
              const all = (await listShortcuts()).filter((s) => s.kind === 'prompt');
              sc =
                all.find((s) => s.label === shortcutName) ??
                all.find((s) => s.label.toLowerCase() === shortcutName.toLowerCase());
            }
            if (shortcutName && !sc) {
              const all = (await listShortcuts()).filter((s) => s.kind === 'prompt');
              resultText = `There is no workflow named "${shortcutName}" — create it first with create_workflow, then schedule it. Available: ${
                all.map((s) => s.label).join(' / ') || '(none)'
              }`;
            } else {
              // Upsert by label so re-creating the same name updates in place.
              const existing = (await listSchedules()).find((s) => s.label === label);
              const schedule: Schedule = {
                id: existing?.id ?? makeScheduleId(),
                label,
                ...(note ? { note } : {}),
                ...(sc
                  ? { shortcutId: sc.id, shortcutLabel: sc.label, prompt: undefined }
                  : { prompt, shortcutId: undefined, shortcutLabel: undefined }),
                cadence: parsed.cadence,
                enabled: true,
                createdAt: existing?.createdAt ?? now,
              };
              await saveSchedule(schedule);
              // Register the alarm (mirrors schedule-runner's syncAlarm).
              let alarmErr = '';
              try {
                if (typeof chrome !== 'undefined' && chrome.alarms) {
                  await chrome.alarms.clear(alarmName(schedule.id));
                  await chrome.alarms.create(
                    alarmName(schedule.id),
                    alarmInfo(schedule.cadence, now),
                  );
                }
              } catch (e) {
                alarmErr = e instanceof Error ? e.message : String(e);
              }
              const target = sc ? `run workflow "${sc.label}"` : 'run the instructions (a full agent session)';
              resultText =
                `Scheduled task "${label}" ${existing ? 'updated' : 'created'}: ${cadenceLabel(
                  parsed.cadence,
                )} ${target}. The user can view / run manually / toggle / delete it on the "Scheduled tasks" page; it notifies when done and the result goes into History.` +
                (alarmErr ? ` ⚠️ But registering the scheduled alarm failed (${alarmErr}), so it may not fire automatically — please let the user know.` : '');
            }
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
          const t = {
            id: traceId,
            action: 'execute_tool' as const,
            tool: call.function.name,
            args,
            status: 'completed' as const,
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
            resolveImageRef: (t) => resolveImageRef(session.id, t),
            availableImageIds: () => listImageIds(session.id),
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

        // Auto-attach only DATA URLs (screenshots) from a tool result, gated on
        // `visionInline` (the PRIMARY can see images). With a SEPARATE vision
        // slot the primary can't be shown bytes — instead every surfaced image
        // is put in the session image registry and the redacted text carries a
        // resolvable [img_N] token the model can hand to view_image (§10.25).
        const images =
          visionInline && r.ok
            ? collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN).filter(isDataUrl)
            : [];
        if (r.ok)
          for (const ref of collectImageRefs(r.result, MAX_VISION_IMAGES_PER_TURN))
            registerImage(session.id, ref);
        if (r.ok) collectSourcesFromTool(call.function.name, r.result, runSources);

        let rawResult = r.ok
          ? typeof r.result === 'string'
            ? r.result
            : safeStringify(r.result)
          : `Error: ${r.error ?? '(unknown)'}`;
        // Strip ALL base64 image data URLs from the TEXT — raw base64 is pure
        // truncation noise; each blob is replaced by its registry token.
        rawResult = stripDataUrls(rawResult, (blob) => `[${registerImage(session.id, blob)}]`);
        const { text: resultStr, truncated: cutChars } = truncateStash(rawResult);
        if (cutChars > 0) {
          ctx.emit({
            type: 'notice',
            level: 'info',
            text: `The "${call.function.name}" result was oversized; truncated ${cutChars.toLocaleString()} characters — the model can read on in chunks with read_more`,
          });
        }

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
          text: `${breaker} paused; rephrase or add information, then send "continue".`,
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
            text: `${stall} You can add information or rephrase, then send "continue".`,
          });
          return finish('checkpoint');
        }
      }

      // One image-bearing user message for the whole turn (after every tool
      // response), so a multimodal model can see the images. Capped to bound
      // request size when many tools fire at once. Each ref is inlined as a
      // normalized base64 data URL (toVisionDataUrl): raw URLs make the
      // PROVIDER's server fetch them, which fails on hotlink-protected/slow
      // CDNs — GLM 1210, Aliyun "Download multimodal file timed out" (§10.24).
      // If OUR fetch fails too, fall back to the raw URL (the provider might
      // still reach it) — EXCEPT where the provider rejects URL images outright
      // (Kimi/Moonshot, §10.24 addendum): there a raw URL 400s the whole request, so
      // dropping just the image is strictly better.
      if (turnImages.length) {
        const capped = turnImages.slice(0, MAX_VISION_IMAGES_PER_TURN);
        const urlFallbackOk = providerAcceptsHttpImageUrl(cfg);
        const prepared = (
          await Promise.all(
            capped.map(
              async (url) =>
                (await toVisionDataUrl(url, { signal: ctx.signal })) ??
                (urlFallbackOk ? url : null),
            ),
          )
        ).filter((u): u is string => u !== null);
        const dropped = capped.length - prepared.length;
        if (prepared.length) {
          const asData = prepared.filter((u) => u.startsWith('data:')).length;
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `(This turn's tool results contain ${prepared.length} image(s), in order below${
                  dropped ? `; ${dropped} more could not be read and were skipped` : ''
                })`,
              },
              ...prepared.map(
                // Provider-shaped (§10.24 addendum): GLM wants RAW base64 payloads.
                (url) =>
                  ({ type: 'image_url', image_url: { url: imageUrlForProvider(cfg, url) } }) as const,
              ),
            ],
          });
          log('api', `vision: attached ${prepared.length} image(s) this turn`, {
            asDataUrls: asData,
            passthroughUrls: prepared.length - asData,
            dropped,
          });
          session.apiMessages = messages;
          await saveSession(session);
        } else {
          log('api', `vision: all ${dropped} image(s) unfetchable; none attached (provider rejects URL images)`);
        }
      }

      // We just executed tool_calls (the no-tool-calls path returned at the guard
      // above), so LOOP to let the model consume the results — REGARDLESS of
      // finish_reason. Some providers return finish_reason 'stop'/'length'
      // ALONGSIDE tool_calls; ending here would leave the results unseen and the
      // final answer empty. Bounded by maxSteps. (§10.14: fold any steer that
      // arrived this turn too.) See audit Tier4-#g.
      await drainSteers();
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
