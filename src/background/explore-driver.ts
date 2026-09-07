/**
 * Explore v2 — "do the task once on a real page while recording, then synthesize
 * a deterministic adapter that re-extracts the data with zero LLM at replay."
 *
 * Lifecycle: startExploreSession opens a dedicated agent tab + begins a trace;
 * the agent calls synthesize_adapter mid-loop (handleSynthesizeAdapter) which
 * generates source from the trace slice, smoke-tests it (verifyExploreAdapter),
 * streams status to the Explore-results card, and advances the slice cursor. After the
 * run, finishExploreSession backstops a single synth if the agent produced none.
 * Also hosts the panel-initiated Run tool (handleRunTool) and trace import.
 */

import { log } from '@base/runtime/log';
import { saveSession } from '../agent/session';
import { executeAdapter } from '../tools/dispatcher';
import { lookupAdapter } from '@base/tools/manifest';
import type { ToolExecResult } from '../agent/engine';
import { ExploreSession } from '../explore/session';
import { adoptTab } from '@base/background/controlled-tabs';
import { createAgentTab } from '@base/background/agent-window';
import { getTrace, createTrace, appendEvents } from '../explore/trace-store';
import { synthesizeAdapter } from '../explore/synthesize';
import { computeResultCriteria, formatCriteria, type ResultCriteria } from '../explore/criteria';
import { pickPaginationArg, nextPageValue, duplicateFraction } from '../explore/pagination-check';
import { consumerTest, consumerWarning } from '../explore/consumer-test';

/** ⑪ Run the cold-reader consumer test after a read adapter verifies. One extra
 * small LLM call per verified read adapter; flip to false to disable wholesale. */
const CONSUMER_TEST_ENABLED = true;
import { parseTraceImport } from '../explore/import';
import { resolveSlots, needsBaseUrl } from '../config/llm-config';
import {
  registerSessionDefs,
  installFromCaptured,
  markVerified,
} from '../adapters/install-manager';
import { broadcastAdaptersChanged } from './adapter-handlers';
import type { CapturedDef } from '../adapters/installed-store';
import { evalAdapterViaOffscreen } from './offscreen-eval';
import { activeSessions } from './active-sessions';
import {
  sendToSidepanel,
  msgOf,
  startKeepalivePing,
  stopKeepalivePingIfIdle,
} from '@base/background/runtime-state';
import { forwardOrchEvent } from './orch-events';
import type {
  ExploreResultEvt,
  SessionNoticeEvt,
  ExploreAdapter,
  ExploreAdapterArg,
  ImportTraceReq,
  ExploreRepairReq,
  RunToolReq,
  RunToolResp,
} from '../messages';

const SCOPE = 'sw';

/** Open a dedicated background tab and begin an explore trace session on it.
 * The agent's explore-aware open_url reuses this tab for all navigation. */
export async function startExploreSession(task: string, owner?: string): Promise<ExploreSession> {
  const tab = await createAgentTab('about:blank');
  if (typeof tab.id !== 'number') throw new Error('failed to open explore tab');
  await adoptTab(tab.id); // F1/T1: agent-controlled → Web Agent tab group
  const traceId = `explore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // owner = the chat sessionId (F-30): only this session's tool calls record.
  return ExploreSession.start({ traceId, tabId: tab.id, task, owner });
}

/** Resume an explore session on a fresh tab, bound to the existing trace
 * (append) with cursor / adapterCount / site restored — E4 resume. The old
 * explore tab is usually gone (SW death / user closed it); the agent re-navigates
 * via open_url. */
export async function resumeExploreSession(
  prior: {
    traceId: string;
    site?: string;
    cursor: number;
    adapterCount: number;
  },
  owner?: string,
): Promise<ExploreSession> {
  const tab = await createAgentTab('about:blank');
  if (typeof tab.id !== 'number') throw new Error('failed to open explore tab');
  await adoptTab(tab.id); // F1/T1: agent-controlled → Web Agent tab group
  return ExploreSession.resume({
    traceId: prior.traceId,
    tabId: tab.id,
    site: prior.site,
    cursor: prior.cursor,
    adapterCount: prior.adapterCount,
    owner, // F-30: same owner (chat sessionId) as the original run
  });
}

/** Stop capture, then synthesize an adapter from the trace and surface the
 * result (or the reason it couldn't). Best-effort; never throws to the caller. */
export async function finishExploreSession(
  sessionId: string,
  explore: ExploreSession,
  signal: AbortSignal,
): Promise<void> {
  const aborted = signal.aborted;
  const producedCount = explore.adapterCount;
  await explore.stop(aborted ? 'aborted' : 'done');
  if (aborted) {
    sendToSidepanel({
      type: 'SESSION_NOTICE',
      sessionId,
      level: 'info',
      text: 'Explore was interrupted; no synthesis performed.',
    } satisfies SessionNoticeEvt);
    return;
  }
  // The agent now synthesizes via synthesize_adapter mid-loop (Explore v2). Only
  // fall back to a single post-loop synth when it produced none (short run / it
  // forgot) — otherwise we'd emit a duplicate adapter from the whole trace.
  if (producedCount === 0) {
    await emitSynthForTrace(sessionId, explore.traceId);
  } else {
    log(
      SCOPE,
      `explore finished with ${producedCount} agent-synthesized adapter(s); skip backstop`,
    );
  }
}

/** Synthesize an adapter for a trace (optionally a repair pass that feeds back
 * the failing source + error) and push the result card to the panel. Keeps the
 * SW alive across the LLM round-trip. Shared by the post-run finish + the
 * panel's "repair from the error" (P4 bounded repair). */
export async function emitSynthForTrace(
  sessionId: string,
  traceId: string,
  repair?: { prevSource: string; error: string },
): Promise<void> {
  startKeepalivePing();
  try {
    const trace = await getTrace(traceId);
    const counts = {
      network: trace?.counts.network ?? 0,
      action: trace?.counts.action ?? 0,
      state: trace?.counts.state ?? 0,
    };
    const base: ExploreResultEvt = {
      type: 'EXPLORE_RESULT',
      sessionId,
      traceId,
      ok: false,
      counts,
    };
    if (!trace) {
      sendToSidepanel({
        ...base,
        error: 'trace not found (may not have captured any data)',
      } satisfies ExploreResultEvt);
      return;
    }
    const primary = (await resolveSlots().catch(() => null))?.primary;
    if (!primary?.apiKey || (needsBaseUrl(primary.provider) && !primary.baseUrl)) {
      sendToSidepanel({ ...base, error: 'no primary model configured; cannot synthesize an adapter' } satisfies ExploreResultEvt);
      return;
    }
    const res = await synthesizeAdapter(
      trace,
      { apiKey: primary.apiKey, baseUrl: primary.baseUrl, provider: primary.provider, model: primary.model },
      { repair },
    );
    sendToSidepanel({
      ...base,
      ok: res.ok,
      site: res.site,
      name: res.name,
      source: res.source,
      summary: res.summary,
      testArgs: res.testArgs,
      error: res.error,
    } satisfies ExploreResultEvt);
    log(
      SCOPE,
      `explore synth trace=${traceId}${repair ? '(repair)' : ''} → ${res.ok ? `${res.site}/${res.name}` : 'fail'}`,
    );
  } finally {
    stopKeepalivePingIfIdle();
  }
}

/** Panel-initiated bounded repair: re-synthesize feeding back the run error. */
export async function handleExploreRepair(m: ExploreRepairReq): Promise<void> {
  await emitSynthForTrace(m.sessionId, m.traceId, { prevSource: m.prevSource, error: m.error });
}

/* ───────── Explore v2: agent-driven synthesize_adapter ───────── */

/** Evaluate adapter source in the sandbox and return the captured defs. Routes
 * through the offscreen document (the panel-free eval venue, §27.3) so explore /
 * install / ephemeral load no longer require the SidePanel to be open. */
async function requestSandboxEval(
  source: string,
): Promise<{ ok: boolean; defs?: CapturedDef[]; error?: string }> {
  const r = await evalAdapterViaOffscreen(source);
  return { ok: r.ok, defs: r.defs as CapturedDef[], error: r.error };
}

/** A stable string signature of a row for differential overlap (first non-empty
 * string value, truncated) — robust to field rename/reorder since we match the
 * VALUE inside the adapter's output blob. */
function rowSig(row: unknown): string {
  if (typeof row === 'string') return row.trim().slice(0, 40);
  if (row && typeof row === 'object') {
    for (const v of Object.values(row as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim().length >= 4) return v.trim().slice(0, 40);
    }
  }
  return '';
}

/** Eval source → session-register → smoke-test through the dispatcher (so the
 * run is paced + recorded into the trace). The agent's automated self-check;
 * the user's authoritative Run tool runs later from the card with their own args. */
async function verifyExploreAdapter(
  source: string,
  tool: string,
  testArgs: Record<string, unknown>,
  expected?: unknown[] | null,
): Promise<{
  ok: boolean;
  rows?: number;
  preview?: string;
  error?: string;
  args?: ExploreAdapterArg[];
  /** Correctness signals beyond "it ran": 0 rows, declared columns empty in all
   * rows, non-array result. "Ran + non-empty" ≠ correct (docs/llm-explore-research §A2). */
  warnings?: string[];
  /** access:'write' adapter — registered but NOT auto-executed (real side
   * effects); verification must go through the in-conversation write-confirm. */
  skippedWrite?: boolean;
  /** Quantitative success criteria derived from the verify result (⑨) — the
   * reusable bar (rows>=N, per-column non-empty rate), surfaced to the agent. */
  criteria?: ResultCriteria;
  /** The adapter's declared description (from the captured def) — fed to the ⑪
   * consumer test, which judges the SPEC (name/description/args) in isolation. */
  description?: string;
  /** The sandbox-eval'd captured defs — handed back so the caller can persist
   * the adapter into the installed store without a second eval. */
  defs?: CapturedDef[];
}> {
  const evaled = await requestSandboxEval(source);
  if (!evaled.ok || !evaled.defs?.length) {
    return { ok: false, error: evaled.error ?? 'the source registered no cli() adapter in the sandbox' };
  }
  try {
    registerSessionDefs(evaled.defs, source);
  } catch (e) {
    return { ok: false, error: `registration failed: ${msgOf(e)}` };
  }
  const def = evaled.defs.find((d) => `${d.site}__${d.name}` === tool) ?? evaled.defs[0];
  const args = Array.isArray(def?.args) ? (def.args as ExploreAdapterArg[]) : undefined;
  // func adapters need the "Allow user scripts" toggle to register/run.
  if (!lookupAdapter(tool)) {
    return {
      ok: false,
      args,
      error:
        'func-type adapters require turning on this extension\'s "Allow user scripts" toggle in chrome://extensions before they can be test-run/reused.',
    };
  }
  // Write adapters are never auto-executed: the smoke test would perform the
  // real side effect (post/like/delete). Only the panel Run tool refused writes
  // before — this automated path executed them (audit 2026-07-02 ①).
  if (def?.access === 'write') {
    return { ok: false, skippedWrite: true, args, defs: evaled.defs };
  }
  try {
    const r = (await executeAdapter({ tool, args: testArgs })) as ToolExecResult;
    if (!r.ok) return { ok: false, error: r.error, args };
    const result = r.result;
    const rows = Array.isArray(result) ? result.length : undefined;
    let preview: string;
    try {
      preview = JSON.stringify(result, null, 2).slice(0, 200_000);
    } catch {
      preview = '[unserializable]';
    }
    // Correctness signals (cheap A2 contract): the smoke "ran", but did it return
    // sane data? Surface 0-rows / non-array / declared-columns-empty so the agent
    // catches a wrong-block / thin result instead of trusting "passed".
    const warnings: string[] = [];
    const cols = Array.isArray((def as { columns?: unknown }).columns)
      ? ((def as { columns?: string[] }).columns as string[])
      : [];
    if (!Array.isArray(result)) {
      warnings.push('result is not an array (the adapter should return an array of objects)');
    } else if (result.length === 0) {
      warnings.push('returned 0 rows (selector/endpoint matched nothing, or loading/expanding needs to be triggered first)');
    } else if (cols.length) {
      const sample = result
        .slice(0, 20)
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      if (sample.length) {
        const empty = cols.filter((c) =>
          sample.every((row) => {
            const v = row[c];
            return v == null || v === '' || (Array.isArray(v) && v.length === 0);
          }),
        );
        if (empty.length) {
          warnings.push(
            `these declared columns are empty/missing in every sample row: ${empty.join(', ')} (may have grabbed the wrong element or missed a field)`,
          );
        }
      }
    }
    // A1 — differential check vs the data the agent extracted live with eval_js:
    // the baked adapter should reproduce roughly that. Catches "wrong block" /
    // "didn't replicate my tested snippet" even when the output looks well-formed.
    if (Array.isArray(expected) && expected.length && Array.isArray(result)) {
      const exp = expected.length;
      const got = result.length;
      const blob = JSON.stringify(result);
      const sigs = expected.slice(0, 10).map(rowSig).filter(Boolean);
      const hit = sigs.filter((s) => blob.includes(s)).length;
      const overlap = sigs.length ? hit / sigs.length : 1;
      if (got / exp < 0.5 || overlap < 0.5) {
        warnings.push(
          `inconsistent with the data you verified via eval_js: you measured ${exp} rows, the adapter returned only ${got}` +
            (overlap < 0.5 ? `, and key values do not match (hit ${hit}/${sigs.length})` : '') +
            ' —— the adapter may not have reproduced the extraction logic you verified; put the working snippet into notes before synthesizing',
        );
      }
    }
    // ⑦ Pagination oracle: if the adapter takes a page/offset arg and returned a
    // list, run page 2 and confirm it's really DIFFERENT data (a page arg that
    // isn't wired → every page repeats page 1).
    const pageArg = pickPaginationArg(args);
    if (pageArg && Array.isArray(result) && result.length >= 2) {
      const p2 = nextPageValue(pageArg, testArgs, result.length);
      try {
        const r2 = (await executeAdapter({
          tool,
          args: { ...testArgs, [pageArg.name]: p2 },
        })) as ToolExecResult;
        if (r2.ok && Array.isArray(r2.result) && r2.result.length) {
          const dupFrac = duplicateFraction(
            result.slice(0, 10).map(rowSig),
            (r2.result as unknown[]).slice(0, 10).map(rowSig),
          );
          if (dupFrac >= 0.8) {
            warnings.push(
              `pagination may not be working: page 2 (${pageArg.name}=${p2}) is highly duplicative of page 1 (${Math.round(dupFrac * 100)}%) —— check whether ${pageArg.name} is actually wired into the request / URL (common trap: declared the arg but never spliced it in)`,
            );
          }
        }
      } catch {
        /* best-effort; a page-2 error isn't a pagination verdict */
      }
    }
    const criteria = computeResultCriteria(result, cols) ?? undefined;
    return {
      ok: true,
      rows,
      preview,
      args,
      warnings: warnings.length ? warnings : undefined,
      criteria,
      description: typeof def?.description === 'string' ? def.description : undefined,
      defs: evaled.defs,
    };
  } catch (e) {
    return { ok: false, error: msgOf(e), args };
  }
}

/** Snapshot the explore binding onto the chat session so a follow-up / crash
 * can resume from the right trace + cursor + adapter count (E4). */
function persistExploreBinding(sessionId: string, explore: ExploreSession): void {
  const active = activeSessions.get(sessionId);
  if (!active) return;
  active.session.explore = {
    traceId: explore.traceId,
    site: explore.site,
    cursor: explore.cursor,
    adapterCount: explore.adapterCount,
  };
  void saveSession(active.session);
}

/** Persist a synthesized adapter (trimmed: drop the bulky verify.preview) onto
 * the chat session so the export bundle + a reloaded panel can recover the
 * SOURCE + verify outcome even after the in-panel card state is gone. */
function persistExploreAdapter(sessionId: string, a: ExploreAdapter): void {
  const active = activeSessions.get(sessionId);
  if (!active) return;
  const trimmed: ExploreAdapter = {
    ...a,
    verify: a.verify ? { ok: a.verify.ok, rows: a.verify.rows, error: a.verify.error } : undefined,
  };
  const list = active.session.exploreAdapters ?? [];
  const i = list.findIndex((x) => x.id === a.id);
  if (i === -1) list.push(trimmed);
  else list[i] = trimmed;
  active.session.exploreAdapters = list;
  void saveSession(active.session);
}

/** Auto-persist a synthesized adapter into the installed store (the Explore-generated
 * tab). The Install button was removed (2026-07-11): a passing verify — or a
 * write adapter whose smoke test is deliberately skipped — lands in the store
 * directly; the user deletes unwanted ones from the tab. Heal runs persist
 * under the ORIGINAL id/origin (manual+healedFrom, no `my-` re-homing) so the
 * healed source replaces the broken one — the same origin mapping the panel's
 * Install button used to apply. Best-effort: a persist failure never fails the
 * synthesis (the adapter stays session-callable either way). */
async function persistSynthesizedAdapter(
  sessionId: string,
  source: string,
  defs: CapturedDef[],
  verifyStatus: 'passed' | 'untested',
  note?: string,
): Promise<boolean> {
  const healTarget = activeSessions.get(sessionId)?.session.healTarget;
  const origin =
    healTarget?.origin.type === 'marketplace'
      ? ({ type: 'manual', healedFrom: 'marketplace' } as const)
      : healTarget && healTarget.origin.type !== 'explore'
        ? ({ type: 'manual' } as const)
        : ({ type: 'explore' } as const);
  try {
    const r = await installFromCaptured({ source, defs, origin }, Date.now());
    if (!r.ok || !r.id) {
      log(SCOPE, `auto-persist failed: ${r.error ?? 'unknown'}`);
      return false;
    }
    await markVerified(r.id, verifyStatus, note);
    broadcastAdaptersChanged();
    log(SCOPE, `auto-persisted ${r.id} (${verifyStatus}${healTarget ? ', heal' : ''})`);
    return true;
  } catch (e) {
    log(SCOPE, `auto-persist error: ${msgOf(e)}`);
    return false;
  }
}

/** The synthesize_adapter ctx hook (engine → here). Synthesize the trace slice
 * the agent just produced into a deterministic adapter, stream its status to the
 * Explore-results card, smoke-test it, advance the slice cursor, and return a concise
 * outcome string for the agent (so it repairs-and-retries or moves on). */
export async function handleSynthesizeAdapter(
  sessionId: string,
  explore: ExploreSession,
  opts: { name?: string; notes?: string },
): Promise<string> {
  const traceId = explore.traceId;
  const id = explore.nextAdapterId();
  const reqName = opts.name?.trim() || undefined;
  const emit = (patch: Partial<ExploreAdapter> & { status: ExploreAdapter['status'] }): void =>
    forwardOrchEvent(sessionId, {
      type: 'explore_adapter',
      adapter: { id, traceId, site: explore.site, name: reqName, ts: Date.now(), ...patch },
    });

  emit({ status: 'synthesizing' });

  await explore.recorder.flush().catch(() => {});
  const full = await getTrace(traceId);
  if (!full || full.events.length === 0) {
    emit({ status: 'failed', error: 'trace is empty (no data captured)' });
    return 'Synthesis failed: no action/network data captured yet. First actually perform this operation on the page.';
  }
  const cursor = explore.cursor;
  const sliceEvents = full.events.filter((e) => e.seq >= cursor);
  const sliceTrace = {
    ...full,
    events: sliceEvents.length ? sliceEvents : full.events,
    task: opts.notes ? `${full.task ?? ''}\nHint: ${opts.notes}`.trim() : full.task,
  };

  const primary = (await resolveSlots().catch(() => null))?.primary;
  if (!primary?.apiKey || (needsBaseUrl(primary.provider) && !primary.baseUrl)) {
    emit({ status: 'failed', error: 'no primary model configured' });
    return 'Synthesis failed: no primary model configured (Settings → Model roles).';
  }

  // Repair loop: if the agent already tried this name, feed the previous source +
  // its error back so the synthesizer FIXES the actual bug instead of
  // regenerating the same class of bug blind (the agent's "try again" → real debug).
  const prev = explore.lastAttemptFor(reqName);
  const expectedSample = explore.lastExtraction() ?? undefined;
  const provenSnippet = explore.lastExtractionCode() ?? undefined;
  const capturedSubmissions = explore.capturedSubmissions();
  const res = await synthesizeAdapter(
    sliceTrace,
    { apiKey: primary.apiKey, baseUrl: primary.baseUrl, provider: primary.provider, model: primary.model },
    {
      ...(prev
        ? {
            repair: {
              prevSource: prev.source,
              error: prev.error || 'the previous version ran but the result was incomplete / did not match the task; please improve it',
            },
          }
        : {}),
      ...(expectedSample ? { expectedSample } : {}),
      ...(provenSnippet ? { provenSnippet } : {}),
      ...(capturedSubmissions.length ? { capturedSubmissions } : {}),
    },
  );
  if (!res.ok || !res.source || !res.site || !res.name) {
    emit({
      status: 'failed',
      error: res.error ?? 'output is not a recognizable cli() adapter',
      summary: res.summary,
    });
    explore.advanceCursor();
    persistExploreBinding(sessionId, explore);
    persistExploreAdapter(sessionId, {
      id,
      traceId,
      site: explore.site,
      name: reqName,
      status: 'failed',
      summary: res.summary,
      error: res.error ?? 'output is not a recognizable cli() adapter',
      ts: Date.now(),
    });
    return `Synthesis did not succeed: ${res.error ?? 'output is not a recognizable cli() adapter'}. Pin down the data source (list_network / read_network / get_html) again, then retry with the same name.`;
  }
  if (res.site) explore.setSite(res.site);
  const tool = `${res.site}__${res.name}`;
  const common = {
    site: res.site,
    name: res.name,
    tool,
    source: res.source,
    summary: res.summary,
    testArgs: res.testArgs,
  };
  emit({ ...common, status: 'verifying' });

  const verify = await verifyExploreAdapter(
    res.source,
    tool,
    res.testArgs ?? {},
    explore.lastExtraction(),
  );
  if (verify.skippedWrite) {
    // Registered but deliberately NOT executed. Keep the attempt (a same-name
    // retry should iterate on this source), status = untested. Still persisted
    // (the Install button is gone; this is the only path for write-type into
    // "Explore-generated") — the untested status is stored truthfully.
    const saved = verify.defs?.length
      ? await persistSynthesizedAdapter(sessionId, res.source, verify.defs, 'untested')
      : false;
    emit({
      ...common,
      args: verify.args,
      status: 'untested',
      ...(saved ? { installed: true } : {}),
    });
    explore.advanceCursor();
    persistExploreBinding(sessionId, explore);
    explore.recordAttempt(reqName, res.source, '');
    persistExploreAdapter(sessionId, {
      id,
      traceId,
      site: res.site,
      name: res.name,
      tool,
      status: 'untested',
      source: res.source,
      summary: res.summary,
      args: verify.args,
      testArgs: res.testArgs,
      ...(saved ? { installed: true } : {}),
      ts: Date.now(),
    });
    log(SCOPE, `synthesize_adapter ${tool} → untested (write; auto-smoke skipped)`);
    const warn = res.warnings?.length
      ? `\n\n⚠️ Automated checks found: ${res.warnings.join('; ')}. Review the source and, if needed, re-run synthesize_adapter with the same name.`
      : '';
    const savedNote = saved
      ? 'Auto-saved to "Adapters → Explore-generated" (status truthfully marked untested; the user can delete it there).'
      : '';
    return (
      `Synthesized and registered ${tool} (access:write). **Write operations get no auto test-run** (they cause real side effects); current status is "untested". ${savedNote}${warn}\n\n` +
      `To verify now: call ${tool} directly (the system pops up a write-confirm first; it only truly executes after the user agrees). Otherwise, at wrap-up you MUST **truthfully state that this adapter has not been test-run/verified**, leaving the user to verify it later.`
    );
  }
  // A passing smoke test lands the adapter in the installed store right away
  // (Explore-generated tab) — the Install button is gone, verify IS the acceptance bar.
  const saved =
    verify.ok && verify.defs?.length
      ? await persistSynthesizedAdapter(
          sessionId,
          res.source,
          verify.defs,
          'passed',
          typeof verify.rows === 'number' ? `${verify.rows} rows` : 'OK',
        )
      : false;
  emit({
    ...common,
    args: verify.args,
    status: verify.ok ? 'passed' : 'failed',
    verify: { ok: verify.ok, rows: verify.rows, preview: verify.preview, error: verify.error },
    ...(saved ? { installed: true } : {}),
  });
  explore.advanceCursor();
  persistExploreBinding(sessionId, explore);
  // Remember this attempt so a same-name retry repairs it; persist the source +
  // verify outcome onto the session for the export bundle / panel restore.
  explore.recordAttempt(reqName, res.source, verify.ok ? '' : (verify.error ?? 'run result was incorrect'));
  persistExploreAdapter(sessionId, {
    id,
    traceId,
    site: res.site,
    name: res.name,
    tool,
    status: verify.ok ? 'passed' : 'failed',
    source: res.source,
    summary: res.summary,
    args: verify.args,
    testArgs: res.testArgs,
    verify: { ok: verify.ok, rows: verify.rows, error: verify.error },
    ...(saved ? { installed: true } : {}),
    ts: Date.now(),
  });
  log(
    SCOPE,
    `synthesize_adapter ${tool} → ${verify.ok ? `passed(${verify.rows ?? '?'} rows)` : 'failed'}`,
  );

  if (verify.ok) {
    // Atomic reuse: a passing adapter is a proven, reusable finding for the site.
    explore.recordFinding({
      kind: 'adapter',
      text: `Operation "${res.name}" now runs; usable via tool ${tool}`,
      ts: Date.now(),
    });
    // Hand the AGENT the actual returned data (not just "passed, N rows") so it
    // can verify the output against the task — "passed" only means ran + non-
    // empty, NOT that it captured everything the user asked for. Without this the
    // agent summarizes from what it saw on the page, not what the adapter returns.
    const preview = verify.preview
      ? `\n\n—— Actual test-run output (excerpt, be sure to check) ——\n${verify.preview.slice(0, 3000)}${
          verify.preview.length > 3000 ? '\n…(truncated)' : ''
        }`
      : '';
    // ⑪ Cold-reader consumer test: hand a fresh LLM ONLY the adapter's public
    // spec (name/site/description/args) and see if a caller could use it without
    // the explore context. Catches specs that assume background knowledge. Fail-
    // open (null on any error) so it never blocks a good synthesis.
    const consumerVerdict = CONSUMER_TEST_ENABLED
      ? await consumerTest(
          { name: res.name, site: res.site, description: verify.description, args: verify.args },
          { apiKey: primary.apiKey, baseUrl: primary.baseUrl, provider: primary.provider, model: primary.model },
        )
      : null;
    const consumerWarn = consumerWarning(consumerVerdict);
    const allWarn = [
      ...(res.warnings ?? []),
      ...(verify.warnings ?? []),
      ...(consumerWarn ? [consumerWarn] : []),
    ];
    const warn = allWarn.length
      ? `\n\n⚠️ Automated checks found: ${allWarn.join('; ')}. Use these to check for wrong/missed extraction and, if needed, re-run synthesize_adapter with the same name.`
      : '';
    // ⑨ Quantitative success criteria from the actual verify result — an honest,
    // reusable bar to state in the wrap-up (and the seed for health checks).
    const crit = verify.criteria
      ? `\n\nSuccess criteria (taken from this test-run; usable as a reuse / health-check baseline): ${formatCriteria(verify.criteria)}`
      : '';
    const savedNote = saved
      ? 'Auto-saved to "Adapters → Explore-generated"; no install needed, the user can manage/delete it there.'
      : '';
    return (
      `Synthesized ${tool}, auto test-run passed, returned ${verify.rows ?? '?'} rows. ${savedNote}${preview}${warn}${crit}\n\n` +
      `⚠️ A test-run "passing" only means it ran and the result is non-empty; it **does NOT mean everything was captured / captured correctly**. Against the user's task, check item by item whether the [actual output] above really contains everything the user asked for (e.g. here: are the AI overview body AND its reference links really both in the result?).` +
      `If content is missing or wrong — the adapter is not right; add selectors / change strategy and re-run synthesize_adapter with the same name (like fixing a bug).` +
      `Only continue to the next operation or wrap up once confirmed; **the final summary given to the user may only describe what the adapter actually returns (the test-run result is authoritative)** — never claim as done anything you saw on the page but that is not actually in the result.`
    );
  }
  return `Synthesized ${tool}, but the auto test-run failed: ${verify.error ?? 'unknown error'}. Fix per the error (e.g. if the endpoint is signed / uses a one-time token, switch to reproducing the page's own fetch via page.evaluate on the host page; if the data only lives in the DOM, switch to DOM scraping), then re-run synthesize_adapter with the same name.`;
}

/** Import an external trace (opencli JSONL or our exported JSON), persist it,
 * then synthesize an adapter from it — same result card as a live explore. */
export async function handleImportTrace(m: ImportTraceReq): Promise<void> {
  const traceId = `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const trace = parseTraceImport(m.text, traceId);
  if (!trace) {
    sendToSidepanel({
      type: 'EXPLORE_RESULT',
      sessionId: m.sessionId,
      traceId,
      ok: false,
      counts: { network: 0, action: 0, state: 0 },
      error:
        'could not parse the trace file — needs opencli\'s trace.jsonl / network.jsonl, or this extension\'s exported <traceId>.json',
    } satisfies ExploreResultEvt);
    return;
  }
  if (m.filename && !trace.task) trace.task = `Import: ${m.filename}`;
  await createTrace({
    traceId: trace.traceId,
    site: trace.site,
    task: trace.task,
    url: trace.url,
    status: trace.status,
    startedAt: trace.startedAt,
    updatedAt: trace.updatedAt,
    counts: trace.counts,
  });
  await appendEvents(trace.traceId, trace.events);
  log(SCOPE, `imported trace ${trace.traceId} (${trace.events.length} events) → synth`);
  await emitSynthForTrace(m.sessionId, trace.traceId);
}

/** Panel-initiated verify (Run tool): run one read tool through the dispatcher and
 * return a compact result. Write adapters are refused (must go through the
 * normal in-conversation write-confirm). */
export async function handleRunTool(m: RunToolReq): Promise<RunToolResp> {
  const adapter = lookupAdapter(m.tool);
  if (!adapter) return { type: 'RUN_TOOL_RESP', ok: false, error: `tool not found: ${m.tool}` };
  if (adapter.access === 'write') {
    return { type: 'RUN_TOOL_RESP', ok: false, error: 'write operations get no auto test-run; run and confirm them manually in the conversation.' };
  }
  startKeepalivePing();
  try {
    const r = (await executeAdapter({ tool: m.tool, args: m.args ?? {} })) as ToolExecResult;
    if (!r.ok) return { type: 'RUN_TOOL_RESP', ok: false, error: r.error };
    const rows = Array.isArray(r.result) ? r.result.length : undefined;
    let preview: string;
    try {
      // Return the full result (capped) so the panel can show it completely +
      // offer copy; large payloads are bounded to keep the message sane.
      preview = JSON.stringify(r.result, null, 2).slice(0, 200_000);
    } catch {
      preview = '[unserializable]';
    }
    return { type: 'RUN_TOOL_RESP', ok: true, rows, preview };
  } catch (e) {
    return { type: 'RUN_TOOL_RESP', ok: false, error: msgOf(e) };
  } finally {
    stopKeepalivePingIfIdle();
  }
}
