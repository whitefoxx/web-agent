/**
 * The engine driver — one user message → one api-engine run, and everything that
 * wraps it: the steer queue (mid-run interjections), the per-write confirm + H9 human
 * takeover gate (makeExecuteTool), explore-mode tab/trace setup, and the finally
 * cleanup (synthesize, drop the session, re-drive leftover steers, notify, reap
 * pool tabs). The actual LLM loop lives in agent/api-engine; this builds the
 * EngineContext and hosts the side effects around it.
 */

import { log, warn, error as logError } from '@base/runtime/log';
import {
  loadSession,
  makeSession,
  saveSession,
  appendTurn,
  type SessionState,
} from '../agent/session';
import { apiEngine } from '../agent/api-engine';
import type { EngineContext, ToolExecResult } from '../agent/engine';
import { executeAdapter, reapPoolTabs } from '../tools/dispatcher';
import { reapRunTabs, touchRunTabs, rotateShownTabs, sweepStaleRunTabs } from './run-tabs';
import { rankAdapters, searchableCorpus } from '../tools/generic/find-adapters';
import { markSiteActive } from '../tools/active-sites';
import { releaseAllMasks } from './mask-keeper';
import { lookupAdapter, needsConfirmation } from '@base/tools/manifest';
import { isEphemeralTool, loadEphemeralAdapter } from './ephemeral-adapter';
import { broadcastAdaptersChanged } from './adapter-handlers';
import { isUserScriptsApiAvailable } from '../userscript/sw-runner';
import { listInstalledAdapters } from '../adapters/install-manager';
import type { ExploreSession } from '../explore/session';
import type { Finding } from '../explore/types';
import { activeSessions } from './active-sessions';
import {
  sendToSidepanel,
  msgOf,
  startKeepalivePing,
  stopKeepalivePingIfIdle,
} from '@base/background/runtime-state';
import { forwardOrchEvent } from './orch-events';
import {
  requestWriteConfirmation,
  requestHumanTakeover,
  requestPlanDecision,
} from './confirm-prompts';
import {
  startExploreSession,
  resumeExploreSession,
  finishExploreSession,
  handleSynthesizeAdapter,
} from './explore-driver';
import { notifyTaskDoneIfClosed } from './notifications';
import type {
  UserMessageReq,
  AbortSessionReq,
  SteerMessageReq,
  InjectContextReq,
  SessionNoticeEvt,
  SessionDoneEvt,
  ModeChangedEvt,
} from '../messages';

const SCOPE = 'sw';

/** Messages injected into a running session via STEER_MESSAGE, drained by the
 * engine on its next turn. Keyed by sessionId. */
const steerQueue = new Map<string, string[]>();

/* ───────── user-message entry points ───────── */

/** Wait (briefly) for a session to leave activeSessions after we aborted it, so
 * a takeover doesn't run two drivers for the same id. Resolves true once idle,
 * false on timeout. §10.20 */
function waitForSessionIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
  if (!activeSessions.has(sessionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const iv = setInterval(() => {
      if (!activeSessions.has(sessionId)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 50);
  });
}

export async function handleUserMessage(m: UserMessageReq): Promise<void> {
  log(SCOPE, `USER_MESSAGE sessionId=${m.sessionId}`, { text: m.text.slice(0, 80) });
  // The panel only sends USER_MESSAGE when it believes the session is idle (a
  // running session gets a STEER instead), so an active session here is a desync
  // — usually a run stuck awaiting a plan decision (the dropped-card hang). Don't
  // hard-error "already running"; abort the stale run and take over, so a
  // reopened/errored session can always be continued. §10.20
  if (activeSessions.has(m.sessionId)) {
    log(SCOPE, `USER_MESSAGE for active ${m.sessionId} → abort stale run + take over`);
    activeSessions.get(m.sessionId)?.abort.abort();
    if (!(await waitForSessionIdle(m.sessionId, 2000))) {
      warn(SCOPE, `stale run ${m.sessionId} didn't free in time; forcing takeover`);
      activeSessions.delete(m.sessionId);
    }
  }
  const session = (await loadSession(m.sessionId)) ?? makeSession(m.sessionId);
  // One-turn heal binding: set/clear on EVERY user message so a follow-up turn
  // in the same session can't silently keep overwriting the healed adapter.
  if (m.healTarget) session.healTarget = m.healTarget;
  else delete session.healTarget;
  await driveApiSession(session, m.text, m.mode, m.images, m.autoApprove, {
    displayText: m.displayText,
    pageRefs: m.pageRefs,
  });
}

/** Append a context message to a session without running the agent (T6d:
 * inject a manual workflow run's result so the agent can use it next turn). */
export async function handleInjectContext(m: InjectContextReq): Promise<void> {
  if (activeSessions.has(m.sessionId)) return; // don't mutate a running session
  const session = (await loadSession(m.sessionId)) ?? makeSession(m.sessionId);
  // Re-check after the async load: if a run started meanwhile, bail rather than
  // racing the engine's own saveSession (last-write-wins could drop the turn).
  if (activeSessions.has(m.sessionId)) return;
  session.apiMessages = [...(session.apiMessages ?? []), { role: 'user', content: m.text }];
  appendTurn(session, { role: 'user', text: m.text, ts: Date.now() });
  await saveSession(session);
}

export function handleAbort(m: AbortSessionReq): void {
  const entry = activeSessions.get(m.sessionId);
  if (!entry) return;
  log(SCOPE, `aborting session ${m.sessionId}`);
  entry.abort.abort();
}

/* ───────── steering ───────── */

/** Queue a steering message for a running session — the engine drains it at the
 * top of its loop AND right before it finishes (api-engine `drainSteers`), so a
 * steer landing on the final turn still gets folded in. If the session already
 * went idle (the steer lost the race against completion), don't drop the user's
 * typed text: re-route it as a normal follow-up turn. See docs/agent-harness.md §10.14. */
export function handleSteer(m: SteerMessageReq): void {
  if (activeSessions.has(m.sessionId)) {
    enqueueSteer(m.sessionId, m.text);
    return;
  }
  void rerouteSteerAsFollowUp(m);
}

function enqueueSteer(sessionId: string, text: string): void {
  const q = steerQueue.get(sessionId) ?? [];
  q.push(text);
  steerQueue.set(sessionId, q);
  log(SCOPE, `steer queued for ${sessionId}`, { pending: q.length });
}

/** A steer that arrived after its session went idle (race against the final
 * turn finishing). Continue the saved session with the steer as a fresh user
 * turn so it's persisted + answered instead of silently lost. */
async function rerouteSteerAsFollowUp(m: SteerMessageReq): Promise<void> {
  const session = await loadSession(m.sessionId);
  if (!session) {
    log(SCOPE, `steer dropped: unknown session ${m.sessionId}`);
    return;
  }
  if (activeSessions.has(m.sessionId)) {
    // A new turn started while we were loading — queue for that run instead.
    enqueueSteer(m.sessionId, m.text);
    return;
  }
  log(SCOPE, `steer for idle ${m.sessionId} → follow-up turn`);
  await driveApiSession(session, m.text);
}

/* ───────── func-adapter environment note ───────── */

/** One-shot guard so we warn about disabled func adapters at most once per SW. */
let disabledFuncNoticeSent = false;

/** When Phase B (userScripts) is off but the user has func adapters installed,
 * a one-line note for the SIDEPANEL BANNER (SESSION_NOTICE) so the user sees
 * their installed site tools are dark. Distinct from the prompt strategy note
 * below — this only fires when there are actually installed func adapters. */
async function disabledFuncAdapterNote(): Promise<string | null> {
  if (isUserScriptsApiAvailable()) return null;
  const rows = await listInstalledAdapters().catch(() => []);
  const funcRows = rows.filter((r) => r.enabled && (r.kind === 'func' || r.kind === 'mixed'));
  if (!funcRows.length) return null;
  const names = funcRows
    .slice(0, 6)
    .map((r) => r.title)
    .join(', ');
  return `The ${funcRows.length} adapter(s) you've generated (${names}${funcRows.length > 6 ? '…' : ''}) need Chrome's "Allow user scripts" switch to run, and it's not enabled — the tools for these sites are unavailable.`;
}

/** Toggle-aware adapter strategy injected into the SYSTEM PROMPT every run so
 * the model's "try an adapter or not" choice is INFORMED by the actual
 * "Allow user scripts" state instead of sampled — it was flip-flopping (one run
 * find_adapters → load_adapter, next run straight to generic tools; sessions
 * s_mrbhronz / s_mrbij8cc). Both directions (adapter-hot-plug §10.39):
 *  - ON  → prefer find_adapters → load_adapter for major-site data tasks.
 *  - OFF → func adapters can't run; use pipeline ones or generic, and guide the
 *          user to enable the toggle in the final answer (convenient going forward). */
function adapterStrategyNote(): string {
  return isUserScriptsApiAvailable()
    ? 'The "Allow user scripts" switch is ON, so func-type site adapters are available. For data-scraping / content-reading tasks on major sites (知乎/微博/B站/小红书/GitHub…), **before diving in, run `find_adapters` to check for a ready-made adapter**; if there is one, `load_adapter` gets it done in one step — don\'t immediately brute-force with generic tools (slow and token-heavy).'
    : 'The "Allow user scripts" switch is currently OFF: **func-type** adapters (`type:func` in `find_adapters` results) can\'t load or run, and `load_adapter` will fail on them — don\'t waste time there. For such tasks, use a `type:pipeline` adapter (which doesn\'t need this switch) or just use generic tools; and **in your final answer, add one line guiding the user** to enable the switch on this extension\'s detail page at `chrome://extensions` (and reload the extension; on Chrome <138, turn on Developer mode first) — once enabled, func adapters work in one step, convenient going forward.';
}

/** Adapters-first, made DETERMINISTIC: instead of relying on the model
 * remembering to find_adapters, the DRIVER scores the user's text against the
 * discovery corpus (marketplace index + registered adapters) before the run and
 * injects the top site-matched hits into the environment note — the search has
 * already happened by the model's first token. Site-level hits only (task-word
 * matches are too noisy for unsolicited injection); empty string when nothing
 * matches or the index is unavailable. */
async function adapterMatchNote(userText: string): Promise<string> {
  let hits;
  try {
    const funcOk = isUserScriptsApiAvailable();
    hits = rankAdapters(userText, await searchableCorpus())
      .filter((r) => r.siteHit)
      // Toggle off → an unloadable func adapter is a dead end; only suggest it
      // when it's ALREADY registered (installed func adapters may still run
      // elsewhere — the strategy note explains the toggle situation).
      .filter((r) => {
        const type = (r as { type?: string }).type;
        return funcOk || type !== 'func' || !!lookupAdapter(`${r.site}__${r.name}`);
      })
      .slice(0, 5);
  } catch {
    return '';
  }
  if (!hits.length) return '';
  const lines = hits.map((r) => {
    const tool = `${r.site}__${r.name}`;
    const loaded = !!lookupAdapter(tool);
    // Registered hits stay expanded in the narrowed tool catalog (their schemas
    // are what the model will call next).
    if (loaded) markSiteActive(String(r.site));
    const status = loaded
      ? 'loaded, call it directly'
      : `not loaded: first load_adapter{site:"${r.site}",name:"${r.name}"}`;
    return `- ${tool} — ${(r.description ?? '').slice(0, 80)} (${status})`;
  });
  return `\n\n### Adapter hints (auto-matched by the system for this task)\n${lines.join('\n')}\nIf any above fits, [prefer the adapter] to get it done in one step (faster and cheaper); if none fits or you want to look further, run find_adapters again with different keywords; only as a last resort drive the page with generic tools.`;
}

/* ───────── tool executor (write gate + H9 takeover) ───────── */

/** Build the shared tool executor for a session: gates `write` adapters behind
 * explicit user approval, then runs via the dispatcher. */
function makeExecuteTool(
  sessionId: string,
  autoApprove: boolean,
): (opts: { tool: string; args: Record<string, unknown> }) => Promise<ToolExecResult> {
  return async (opts) => {
    const adapter = lookupAdapter(opts.tool);
    // Auto mode skips the per-write confirmation (the write still runs + is
    // recorded in the trace). Off → confirm each write in the panel as before.
    // ④ Confirm gate: WRITE (unless auto), or any `confirmBeforeUse` adapter
    // (always). `adapter &&` narrows it non-null for the body below.
    if (adapter && needsConfirmation(adapter, autoApprove)) {
      // Flag ephemeral (not-installed) adapters in the confirm so the user knows
      // they're approving a write from code that was loaded on demand.
      const desc = isEphemeralTool(opts.tool)
        ? `[loaded on demand] ${adapter.description ?? ''}`.trim()
        : adapter.description;
      const approved = await requestWriteConfirmation(sessionId, opts.tool, opts.args, desc);
      if (!approved) {
        return {
          ok: false,
          error: 'User declined to execute this write operation.',
          durationMs: 0,
        };
      }
    }
    const result = (await executeAdapter({ ...opts, origin: sessionId })) as ToolExecResult;
    // Human-in-the-loop recovery (H9): a login/auth wall is something the agent
    // can't pass, but the user (right here at the browser) can. Pause, let them
    // take over the focused tab, then retry once — the login cookies now satisfy
    // it. Manual mode only: auto mode runs unattended, so we surface the error.
    if (result.errorKind === 'auth_required' && !autoApprove) {
      const tabId =
        result.tabId ?? (typeof opts.args.tab_id === 'number' ? opts.args.tab_id : undefined);
      const resume = await requestHumanTakeover(sessionId, opts.tool, tabId, result.authDomain);
      if (resume) return (await executeAdapter({ ...opts, origin: sessionId })) as ToolExecResult;
    }
    return result;
  };
}

/* ───────── the run ───────── */

const TOOL_TOKEN_RE = /⟦tool:([^⟧]+)⟧/g;

/** The user text (from the composer, a workflow recipe, or a schedule prompt) may
 * reference site adapters by `⟦tool:site__name⟧` that the palette let them pick
 * but that aren't loaded yet. Load those on demand so the agent can actually call
 * them — the ephemeral-load twin of the old `⟦wf:..⟧` injection. Generic tools
 * and already-registered adapters are skipped; failures are swallowed (the agent
 * can still find_adapters as a fallback). */
async function preloadReferencedAdapters(userText: string): Promise<void> {
  const toLoad = new Map<string, [string, string]>();
  for (const m of userText.matchAll(TOOL_TOKEN_RE)) {
    const tool = m[1].trim();
    if (!tool || lookupAdapter(tool)) continue; // already registered
    const sep = tool.indexOf('__');
    if (sep < 0) continue;
    const site = tool.slice(0, sep);
    const name = tool.slice(sep + 2);
    if (!site || !name || site === 'generic') continue;
    toLoad.set(tool, [site, name]);
  }
  if (toLoad.size === 0) return;
  const results = await Promise.all(
    [...toLoad.values()].map(([site, name]) =>
      loadEphemeralAdapter(site, name)
        .then((r) => r.ok)
        .catch(() => false),
    ),
  );
  // A SW-internal load (unlike load_adapter over the message-router / bridge)
  // doesn't otherwise refresh the sidepanel UI + external bridge tool catalogs —
  // notify once so both reflect the just-loaded adapters.
  if (results.some(Boolean)) broadcastAdaptersChanged();
}

export async function driveApiSession(
  session: SessionState,
  userText: string,
  mode?: 'chat' | 'plan' | 'explore',
  userImages?: string[],
  autoApprove?: boolean,
  userDisplay?: EngineContext['userDisplay'],
): Promise<void> {
  const abortCtl = new AbortController();
  // Per-conversation auto mode: skip write-confirm for this run (captured into
  // the engine ctx below; also persisted so a resumed run keeps it).
  session.autoApprove = !!autoApprove;
  activeSessions.set(session.id, { session, abort: abortCtl });
  startKeepalivePing(); // pin the SW for the whole turn (see startKeepalivePing)
  // Banner: only when installed func adapters are dark (toggle off). Prompt
  // note: toggle-aware adapter strategy on EVERY run (both directions) so the
  // model doesn't flip-flop between adapter-first and generic-first (§10.39).
  const bannerNote = await disabledFuncAdapterNote();
  if (bannerNote && !disabledFuncNoticeSent) {
    disabledFuncNoticeSent = true;
    sendToSidepanel({
      type: 'SESSION_NOTICE',
      sessionId: session.id,
      level: 'warning',
      text: `${bannerNote} Enable it by turning on this switch for the extension at chrome://extensions and reloading the extension.`,
    } satisfies SessionNoticeEvt);
  }
  // The user is back with a new ask — last run's shown pages (active-opened tabs
  // they were shown) are done being viewed; mark them reap-eligible so this
  // run's END collects them (a tab they're STILL looking at gets spared there).
  await rotateShownTabs(session.id);

  // Load any adapters the user referenced via ⟦tool:site__name⟧ that aren't
  // registered yet, so those tokens are actually callable this run. BEFORE the
  // match note below, so preloaded ones correctly show as loaded.
  await preloadReferencedAdapters(userText);

  // Environment note = toggle-aware strategy + the deterministic run-start
  // adapter match (adapters-first without relying on the model's memory).
  // Explore runs skip the match — their deliverable is a NEW adapter.
  const matchNote =
    (mode ?? 'chat') === 'explore' ? '' : await adapterMatchNote(userText).catch(() => '');
  const envNote = adapterStrategyNote() + matchNote;

  // Explore mode: open a dedicated tab + begin trace capture BEFORE the run, so
  // the agent's open_url reuses it and the session-wide network capture is live
  // for the whole task. Synthesis runs after the loop (finishExploreSession).
  // Also invoked MID-RUN by ctx.enterExploreMode (chat→explore upgrade) — a
  // ref holder (not a bare let) so TS keeps the union across the closures.
  const exploreRef: { current: ExploreSession | null } = { current: null };
  let runMode: 'chat' | 'plan' | 'explore' = mode ?? 'chat';
  const beginExplore = async (): Promise<void> => {
    const prior = session.explore;
    if (prior?.traceId) {
      // Resume: rebind to the existing trace (append) so a follow-up continues
      // the prior exploration instead of starting over (E4).
      const ex = await resumeExploreSession(prior, session.id);
      exploreRef.current = ex;
      sendToSidepanel({
        type: 'SESSION_NOTICE',
        sessionId: session.id,
        level: 'info',
        text: `🔍 Continuing exploration (reusing trace ${ex.traceId} and existing findings). Operations already verified can be reused directly.`,
      } satisfies SessionNoticeEvt);
    } else {
      const ex = await startExploreSession(userText, session.id);
      exploreRef.current = ex;
      session.explore = { traceId: ex.traceId, cursor: 0, adapterCount: 0 };
      await saveSession(session);
      sendToSidepanel({
        type: 'SESSION_NOTICE',
        sessionId: session.id,
        level: 'info',
        text: `🔍 Exploration started (trace ${ex.traceId}). I'll do the task once on the real page while recording throughout, synthesizing a reusable adapter as I go.`,
      } satisfies SessionNoticeEvt);
    }
  };
  if (runMode === 'explore') {
    try {
      await beginExplore();
    } catch (e) {
      logError(SCOPE, 'explore start failed', e);
      sendToSidepanel({
        type: 'SESSION_NOTICE',
        sessionId: session.id,
        level: 'warning',
        text: `Couldn't start exploration: ${msgOf(e)} — falling back to normal execution.`,
      } satisfies SessionNoticeEvt);
      runMode = 'chat';
    }
  }

  // How the engine's loop finished (session_done reason), observed off the event
  // stream — the run-tab janitor keeps a `checkpoint`'s tabs (the next "Continue"
  // turn reuses them) and reaps everything else.
  let doneReason: string | undefined;
  const ctx: EngineContext = {
    session,
    userText,
    userImages,
    userDisplay,
    signal: abortCtl.signal,
    mode: runMode,
    environmentNote: envNote ?? undefined,
    emit: (evt) => {
      if (evt.type === 'session_done') doneReason = evt.reason;
      forwardOrchEvent(session.id, evt);
    },
    executeTool: makeExecuteTool(session.id, !!session.autoApprove),
    requestPlanDecision: (plan) => requestPlanDecision(session.id, plan),
    confirmWrite: (o) => requestWriteConfirmation(session.id, o.tool, o.args, o.description),
    awaitUserAction: (objective, tabId, resume) =>
      requestHumanTakeover(session.id, 'await_user_action', tabId, undefined, objective, resume),
    takeSteerMessages: () => {
      const q = steerQueue.get(session.id);
      if (!q || q.length === 0) return [];
      steerQueue.delete(session.id);
      return q;
    },
    synthesizeExploreAdapter: (o) => {
      // The explore binding is non-null whenever the agent can see
      // synthesize_adapter (it's only offered in explore mode); guard anyway.
      const ex = exploreRef.current;
      if (!ex) return Promise.resolve('synthesize_adapter is only available in Explore mode.');
      return handleSynthesizeAdapter(session.id, ex, o);
    },
    noteFinding: (f) => {
      const ex = exploreRef.current;
      if (!ex) return;
      const kinds: Finding['kind'][] = ['endpoint', 'selector', 'step', 'fact', 'login', 'adapter'];
      const kind = kinds.includes(f.kind as Finding['kind']) ? (f.kind as Finding['kind']) : 'fact';
      ex.recordFinding({ kind, text: f.text, ts: Date.now() });
    },
    // Chat→explore upgrade, requested by the agent (enter_explore_mode tool)
    // when the ask needs adapter synthesis/repair. Confirm with the user (the
    // write-confirm card; auto mode = unattended, skip the ask like any write),
    // then run the SAME setup as a /explore run start and flip ctx.mode — the
    // engine re-reads it every iteration (tools + prompt playbook).
    enterExploreMode: async (reason) => {
      if (exploreRef.current) return 'Already in Explore mode; just continue.';
      const approved =
        !!session.autoApprove ||
        (await requestWriteConfirmation(
          session.id,
          'enter_explore_mode',
          {},
          reason || 'Need to enter Explore mode to synthesize / modify a site adapter',
        ));
      if (!approved)
        return "The user declined to enter Explore mode. Don't explore: do your best to help the user the normal way, or truthfully explain that this task can only be completed in Explore mode.";
      try {
        await beginExplore();
      } catch (e) {
        logError(SCOPE, 'mid-run explore start failed', e);
        return `Couldn't start exploration: ${msgOf(e)}. Continuing in normal mode.`;
      }
      runMode = 'explore';
      ctx.mode = 'explore';
      sendToSidepanel({
        type: 'MODE_CHANGED',
        sessionId: session.id,
        mode: 'explore',
      } satisfies ModeChangedEvt);
      return 'The user approved; now in Explore mode: the system is recording page actions + network traffic, and the explore guide and tools like synthesize_adapter will be available from the next turn. Continue with the explore flow: first get the target operation fully working on the real page (confirm the data source), then synthesize_adapter to synthesize it.';
    },
  };
  let runError: string | null = null;
  try {
    await apiEngine.run(ctx);
  } catch (e) {
    logError(SCOPE, 'apiEngine.run threw', e);
    runError = msgOf(e);
    // The run threw WITHOUT calling the engine's finish() (e.g. requestPlanDecision
    // rejecting on panel-close/timeout, or saveSession on IDB quota) — so the
    // shared session object is still status:'running'. Persist a terminal status
    // here (the finally's saveSession commits it) or the session stays stuck
    // 'running' in the list / wedged on reload, even though the UI got this
    // SESSION_DONE. See §10.29.
    session.status = 'error';
    sendToSidepanel({
      type: 'SESSION_DONE',
      sessionId: session.id,
      reason: 'error',
      error: msgOf(e),
    } satisfies SessionDoneEvt);
  } finally {
    // Finalize the explore trace + synthesize BEFORE we drop the session from
    // activeSessions (which would let the keepalive ping stop) — synthesis is
    // another LLM round-trip and needs the SW alive.
    const ex = exploreRef.current;
    if (ex) {
      try {
        await finishExploreSession(session.id, ex, abortCtl.signal);
      } catch (e) {
        logError(SCOPE, 'explore finish failed', e);
      }
      // Keep the explore binding fresh (site may have been resolved even with no
      // adapter synthesized) so a follow-up in explore mode resumes this trace.
      session.explore = {
        traceId: ex.traceId,
        site: ex.site,
        cursor: ex.cursor,
        adapterCount: ex.adapterCount,
      };
    }
    activeSessions.delete(session.id);
    // Backstop (§10.14): a steer can still be in the queue here — it landed
    // after the engine's last drain, via a finish path that doesn't re-drain
    // (checkpoint / error / abort) OR the microtask race against this cleanup.
    // Don't drop it: re-drive it as a follow-up turn so it's persisted +
    // answered instead of vanishing on reload.
    const leftoverSteers = steerQueue.get(session.id) ?? [];
    steerQueue.delete(session.id);
    stopKeepalivePingIfIdle(); // release the SW once no session is running
    await saveSession(session);
    if (leftoverSteers.length) {
      log(SCOPE, `re-driving ${leftoverSteers.length} leftover steer(s) for ${session.id}`);
      void rerouteSteerAsFollowUp({
        type: 'STEER_MESSAGE',
        sessionId: session.id,
        text: leftoverSteers.join('\n'),
      });
    } else {
      // Turn fully finished — if the panel is closed, ping the user (the headline
      // use case: auto mode on + panel closed + come back when it's done).
      await notifyTaskDoneIfClosed(session, runError);
      // Run-tab janitor (deterministic "clear tabs"): close the background tabs
      // THIS run's open_url created — the model chronically forgot close_tab, so
      // the harness owns cleanup now. A `checkpoint` keeps its tabs for the
      // "Continue" turn (its record clock is refreshed instead); user-focused tabs
      // are spared inside reapRunTabs.
      if (doneReason === 'checkpoint') {
        void touchRunTabs(session.id);
      } else {
        void reapRunTabs(session.id).then(
          (n) => {
            if (n) log(SCOPE, `reaped ${n} run tab(s) for ${session.id}`);
          },
          () => {},
        );
      }
      // All agent work is idle now → close background site tabs the dispatcher
      // opened for this task so they don't pile up (keeps the user's own/adopted
      // tabs and any in-use lease; the pool re-warms on the next same-site call).
      if (activeSessions.size === 0) {
        // Run over — drop the "agent is driving" masks right away (the in-page
        // ping would get there within a cycle anyway; this is for instant feel).
        void releaseAllMasks();
        void reapPoolTabs().then(
          (n) => {
            if (n) log(SCOPE, `reaped ${n} idle pool tab(s)`);
          },
          () => {},
        );
        // Collect run-tab records abandoned by SW restarts / parked checkpoints
        // past their grace period.
        void sweepStaleRunTabs().catch(() => {});
      }
    }
  }
}
