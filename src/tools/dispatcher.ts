/**
 * Tool dispatcher — finds the adapter for a `site__name` tool, leases a target
 * tab for the adapter's site from a bounded per-site POOL, attaches CDP via
 * PageShim, runs the adapter, detaches, then returns the tab to the pool.
 *
 * Concurrency (parallel-execution v3): same-site calls each lease their own
 * exclusive tab (up to POOL_MAX_PER_SITE) and run in parallel — replacing the
 * old single shared tab + coarse `site:<site>` lock. Each lease is exclusive so
 * no two calls ever attach CDP to the same tab. See docs/parallel-execution.md.
 *
 * Lives in the service worker. The api-engine calls into this via the
 * `EngineContext.executeTool` interface.
 */

import { lookupAdapter, type AdapterDef } from '@base/tools/manifest';
import { runPipeline, pipelineNeedsPage, type Pipeline } from '../runtime/opencli/pipeline';
import { createPageShim } from '@base/runtime/page';
import { log, warn, error as logError } from '@base/runtime/log';
import { RateLimitedError, AuthRequiredError, EmptyResultError } from '@base/runtime/errors.js';
import { runInstalledFuncAdapter } from '../userscript/sw-runner';
import { getActiveExploreSession, exploreShouldRecord } from '../explore/session';
import { baseSite } from '../adapters/namespace';
import {
  recordRun,
  getAdapterHealth,
  toHealthId,
  type HealthErrorKind,
} from '../adapters/adapter-health-store';
import { withKeyLock } from './key-lock';
import { armAgentMask } from '../background/mask-keeper';
import { SiteTabPool, type TabOps, type TabLease } from './site-tab-pool';
import { createPoolReaper } from './pool-reaper';
import { adoptTab } from '@base/background/controlled-tabs';
import { createAgentTab, ensureAgentWindowId } from '@base/background/agent-window';
import { recordRunTab } from '../background/run-tabs';
import { adapterHintForUrl } from '../background/adapter-hints';
import {
  getSecretsCached,
  resolveEnvForSource,
  substitutePlaceholders,
  redactSecrets,
  type SecretMap,
} from '../config/secret-store';
import {
  getRedactPatternsCached,
  applyRedactPatterns,
  type RedactPattern,
} from '../config/redaction-store';

/** Max concurrent tabs (= max in-flight calls) per site. Same-site calls beyond
 *  this queue for a tab; different sites and tab-less HTTP are unbounded here. */
const POOL_MAX_PER_SITE = 5;

/** Call origins that belong to an EXTERNAL agent (WS bridge / Port MCP), not to
 * an in-extension run. They have no "run end", so the run-tab janitor must not
 * record their tabs: the external agent owns its tabs' lifecycle and closes them
 * itself. Recording them meant the 6h stale sweep could yank a tab out from under
 * a long-lived external session ("tab N no longer exists" on the next call).
 * 'webmcp' was missing here — run-tabs.ts documented the exclusion, the code only
 * had 'bridge'. */
const EXTERNAL_ORIGINS = new Set(['bridge', 'webmcp']);

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorKind?: 'rate_limited' | 'auth_required' | 'empty' | 'tool_not_found' | 'tab' | 'generic';
  /** The tab the tool was on when it failed needing a human (auth_required), so
   * the panel's takeover prompt can focus it. H9-P1. */
  tabId?: number;
  /** The host that needs auth (AuthRequiredError.domain), for the takeover prompt. */
  authDomain?: string;
  durationMs: number;
}

/** Default landing URL for each site we know how to drive. */
const SITE_LANDING_URL: Record<string, string> = {
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
};

/** chrome.tabs.query URL pattern to find an existing tab for a site. */
const SITE_QUERY_URL: Record<string, string[]> = {
  xiaohongshu: ['https://www.xiaohongshu.com/*', 'https://xiaohongshu.com/*'],
};

/** Inter-call pacing (anti-bot defence). When the agent fires several adapters
 * back-to-back we want each subsequent call on the SAME tab to wait a human-ish
 * amount of time before kicking off.
 *
 * The PageShim itself already adds 0.8-1.8s before each navigation and 1.2-2.4s
 * after, but that only kicks in if the adapter actually calls `page.goto`. This
 * dispatcher-level pacing closes that loophole and enforces a hard minimum gap
 * between consecutive calls on the same bucket — even if the adapter is purely
 * read-from-current-page.
 *
 * The bucket is the LEASED TAB (`tab:<id>`) for site adapters — v3 runs parallel
 * same-site calls on DIFFERENT tabs, so they pace independently instead of
 * serializing on one per-site bucket — and `'generic'` for the tab-less generic
 * tools. */
const MIN_INTERVAL_MS = 2500;
const HUMAN_PAUSE_MIN_MS = 600;
const HUMAN_PAUSE_MAX_MS = 1800;

const lastCallTsByBucket = new Map<string, number>();

async function humanPace(bucket: string): Promise<void> {
  const now = Date.now();
  const last = lastCallTsByBucket.get(bucket) ?? 0;
  const elapsed = now - last;
  const jitter =
    HUMAN_PAUSE_MIN_MS + Math.floor(Math.random() * (HUMAN_PAUSE_MAX_MS - HUMAN_PAUSE_MIN_MS));
  let totalWait = jitter;
  if (elapsed < MIN_INTERVAL_MS) totalWait += MIN_INTERVAL_MS - elapsed;
  log('dispatcher', `humanPace bucket=${bucket} sleep=${totalWait}ms (elapsed=${elapsed}ms)`);
  await new Promise((r) => setTimeout(r, totalWait));
  lastCallTsByBucket.set(bucket, Date.now());
}

/** Serialization key for a tool call, or null if it touches no shared tab (safe
 * to run fully in parallel). See the table in docs/parallel-execution.md §5. */
export function lockKeyFor(tool: string, args: Record<string, unknown>): string | null {
  const adapter = lookupAdapter(tool);
  if (!adapter) return null;
  // Generic tools act on an explicit tab_id → serialize per tab. No tab_id
  // (open_url opening a fresh tab, list_tabs, …) → nothing shared, no lock.
  if (adapter.site === 'generic') {
    const tabId = (args as { tab_id?: unknown })?.tab_id;
    return typeof tabId === 'number' ? `tab:${tabId}` : null;
  }
  // Site adapters no longer take a dispatcher lock: they serialize via the
  // per-site tab POOL (sitePool.acquire leases an EXCLUSIVE tab), so up to
  // POOL_MAX_PER_SITE run in parallel — each on its own tab. Tab-less HTTP
  // pipelines touch no tab and were already lock-free. See docs §5/§8.
  return null;
}

export async function executeAdapter(opts: {
  tool: string;
  args: Record<string, unknown>;
  /** Who is making this call (F-30 isolation): the chat sessionId for the
   * SidePanel agent, `'bridge'` for external-agent /command. A tool call is
   * recorded into the active explore trace ONLY when this matches the session's
   * owner — so a bridge call can't contaminate a SidePanel explore (or vice
   * versa). Undefined (verify smoke-tests / workflows) always records. */
  origin?: string;
}): Promise<ToolExecResult> {
  // ── Secret binding (see secret-store.ts / docs/adapter-secrets.md) ──
  // This is the universal tool chokepoint (agent, bridge, explore all land
  // here), so all three secret paths live here:
  //   • substitute `{{secret:NAME}}` placeholders in args → real values, BEFORE
  //     execution (the model only ever emitted the placeholder);
  //   • env-inject func adapters from the vault (done in executeAdapterInner,
  //     which gets `secrets`);
  //   • redact any known secret value out of the RESULT before it leaves.
  // Ordering matters: the explore trace must record the PLACEHOLDER args and the
  // REDACTED result, never a raw secret — so we record after redaction with the
  // ORIGINAL opts.args.
  // This is the universal tool chokepoint — it must NEVER reject: every caller
  // (agent turn, bridge, verify) relies on a {ok:false} ToolExecResult + health
  // recording. A throw in secret-binding / redact / the exec chain would break
  // the caller AND skip recordHealthOutcome. So compute the result under a guard,
  // classify a throw into a failed result, and record health + notes exactly
  // once after. See §10.31.
  const t0 = Date.now();
  let result: ToolExecResult;
  try {
    const secrets = await getSecretsCached();
    const patterns = await getRedactPatternsCached(); // user redaction rules (⑦)
    const hasSecrets = Object.keys(secrets).length > 0;
    const needRedact = hasSecrets || patterns.length > 0;
    const execArgs = hasSecrets
      ? (substitutePlaceholders(opts.args ?? {}, secrets).value as Record<string, unknown>)
      : (opts.args ?? {});
    const execOpts = { tool: opts.tool, args: execArgs };

    // Generic tools on the SAME explicit tab_id serialize (one CDP attach at a
    // time). Everything else runs in parallel: different tabs, tab-less HTTP, and
    // site adapters — which now lease an exclusive tab from the per-site pool
    // (parallel-execution v3), so same-site calls parallelize up to the pool cap.
    const key = lockKeyFor(opts.tool, execArgs);
    const raw = key
      ? await withKeyLock(key, () => executeAdapterInner(execOpts, secrets))
      : await executeAdapterInner(execOpts, secrets);
    result = needRedact ? redactResult(raw, secrets, patterns) : raw;
    // Explore recording (best-effort): every tool call becomes an action event on
    // the active trace. No-op when not exploring. Uses ORIGINAL args (placeholders,
    // not values) and the already-redacted result.
    const session = getActiveExploreSession();
    if (session && exploreShouldRecord(session.owner, opts.origin)) {
      try {
        session.recordAction({
          stream: 'action',
          tool: opts.tool,
          args: opts.args,
          status: result.ok ? 'ok' : 'fail',
          durationMs: result.durationMs,
          resultDigest: result.ok ? digestResult(result.result) : undefined,
          errorMessage: result.ok ? undefined : result.error,
        });
      } catch (e) {
        warn('dispatcher', 'explore recordAction failed (ignored)', e);
      }
    }
  } catch (e) {
    // Secret binding / redact / exec chain threw — honor the contract: a
    // classified failed result, not a rejected promise.
    result = classifyError(t0, e);
  }
  recordHealthOutcome(opts.tool, result);
  // Cockpit mask (A, §4.3.6): every tool touching a tab keeps the "agent is
  // driving" mask alive on it — including open_url CREATING the tab (its tabId
  // is in the result), so the mask is up from the moment a tab joins the run.
  // Fire-and-forget; armAgentMask no-ops when the user setting is off.
  const touched = Number(
    (opts.args as { tab_id?: unknown } | undefined)?.tab_id ??
      (result.ok && result.result && typeof result.result === 'object'
        ? (result.result as { tabId?: unknown }).tabId
        : undefined),
  );
  if (Number.isFinite(touched) && touched > 0) void armAgentMask(touched);
  if (result.ok) {
    const r = result.result as
      | { tabId?: unknown; active?: unknown; explore?: unknown; created_tab?: unknown }
      | undefined;
    // Run-tab janitor: remember every tab this run CREATED so the engine driver
    // can close them (the model no longer has to remember close_tab). Keyed on
    // the result's `created_tab` marker, NOT on the tool name — open_url is no
    // longer the only tool that leaves a tab behind (get_page_text
    // {keep_open:true} does too), and a tool-name check silently leaks those.
    // Background tabs reap at run end; ACTIVE opens are user-facing "display
    // pages" — they survive their own run and get recycled when the NEXT run
    // starts (unless the user is still viewing them). Never recorded: the explore
    // tab (explore-driver owns it) and EXTERNAL_ORIGINS (external agents own
    // their tabs' lifecycle — see run-tabs.ts header).
    if (
      r?.created_tab &&
      opts.origin &&
      !EXTERNAL_ORIGINS.has(opts.origin) &&
      typeof r.tabId === 'number' &&
      !r.explore
    ) {
      void recordRunTab(opts.origin, r.tabId, { userFacing: !!r.active });
    }
  }
  // Adapters-first JIT hint at BOTH generic-driving moments — opening a site's
  // page AND reading its content — while ready-made adapters for it sit
  // unloaded → point at them, in the result itself (once per origin+site).
  // Best-effort. Session s_mregtz8u: the open_url hint alone missed the case
  // where the agent read an already-open tab (get_page_text tab_id on zhihu).
  // fetch_url joined the list when it gained format:"markdown" — it is now a
  // third "read this site" moment, and §10.45's lesson was that every such
  // moment needs the gate or the hint silently misses that path.
  if (
    result.ok &&
    (opts.tool === 'generic__open_url' ||
      opts.tool === 'generic__get_page_text' ||
      opts.tool === 'generic__fetch_url')
  ) {
    try {
      // args.url is the intended destination (result.url can be "" while the
      // tab is still loading); tab_id tools resolve the live tab's URL.
      let url = typeof opts.args?.url === 'string' ? opts.args.url : '';
      const tabIdArg = Number((opts.args as { tab_id?: unknown } | undefined)?.tab_id);
      if (!url && Number.isFinite(tabIdArg) && tabIdArg > 0) {
        url = (await chrome.tabs.get(tabIdArg)).url ?? '';
      }
      const hint = url ? await adapterHintForUrl(opts.origin, url) : null;
      if (hint && result.result && typeof result.result === 'object') {
        (result.result as Record<string, unknown>).adapter_hint = hint;
      }
    } catch {
      /* hint is advisory — never fail the call over it */
    }
  }
  return withAdapterNotes(opts.tool, result);
}

/** Deep-scrub known secret values out of a tool result/error before it becomes a
 * `tool` message in the conversation. Strings stay strings (substring replace),
 * so the error cast is safe. */
function redactResult(
  result: ToolExecResult,
  secrets: SecretMap,
  patterns: RedactPattern[],
): ToolExecResult {
  // Scrub known secret VALUES, then apply user redaction PATTERNS (⑦).
  const scrub = (v: unknown): unknown => applyRedactPatterns(redactSecrets(v, secrets), patterns);
  if (result.ok) return { ...result, result: scrub(result.result) };
  if (typeof result.error === 'string') return { ...result, error: scrub(result.error) as string };
  return result;
}

/** Map the dispatcher's errorKind onto the health store's (drops tool_not_found). */
function toHealthKind(k: ToolExecResult['errorKind']): HealthErrorKind | undefined {
  return k && k !== 'tool_not_found' ? k : undefined;
}

/** Fire-and-forget: fold this run's outcome into the adapter health monitor
 * (H1-P1). Generic primitives don't drift, and tool_not_found isn't a drift. */
function recordHealthOutcome(tool: string, result: ToolExecResult): void {
  const id = toHealthId(tool);
  if (!id) return;
  if (!result.ok && result.errorKind === 'tool_not_found') return;
  void recordRun(
    id,
    result.ok,
    result.ok ? undefined : toHealthKind(result.errorKind),
    result.ok ? undefined : result.error,
  );
}

/** ⑩ On a site-adapter FAILURE, append its agent-authored experience notes to the
 * error so the agent debugging the break sees prior context ("site moved the API
 * to /v2", "needs the new consent click"). Best-effort; returns the result
 * unchanged when there are no notes. */
async function withAdapterNotes(tool: string, result: ToolExecResult): Promise<ToolExecResult> {
  if (result.ok || typeof result.error !== 'string') return result;
  const id = toHealthId(tool);
  if (!id) return result;
  try {
    const notes = (await getAdapterHealth(id))?.notes ?? [];
    if (!notes.length) return result;
    const body = notes
      .slice(-3)
      .map((n) => `- ${n.text}`)
      .join('\n');
    return {
      ...result,
      error: `${result.error}\n\n📝 Past experience notes for this adapter (troubleshooting reference):\n${body}`,
    };
  } catch {
    return result;
  }
}

function digestResult(result: unknown): string {
  try {
    if (Array.isArray(result)) {
      const sample = result.length ? ` first=${JSON.stringify(result[0]).slice(0, 200)}` : '';
      return `array(${result.length})${sample}`;
    }
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return '[unserializable]';
  }
}

/** Cheap proxy for "can chrome.userScripts.execute run in this tab?" — a non-http(s)
 * URL is rejected outright (restricted scheme), otherwise attempt a trivial
 * chrome.scripting injection (same host-permission + scriptable-page rules). A
 * discarded background tab, an error page, or a degraded junk tab fails the probe.
 * Returns true if the tab is gone (nothing to recover; the real execute reports it). */
async function isLikelyInjectable(tabId: number): Promise<boolean> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return true;
  }
  if (!/^https?:/i.test(tab.url ?? '')) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
    return true;
  } catch {
    return false;
  }
}

/** A degraded tab pool — notably after an MV3 SW restart mid-session — can hand
 * back a tab parked on a restricted scheme (about:blank / chrome://newtab) that
 * `chrome.userScripts.execute` refuses to inject into ("Cannot access contents of
 * the page. Extension manifest must request permission…"), even though
 * host_permissions is <all_urls>. func adapters then fail cryptically — including
 * `browser:false` ones, which don't care about the page yet still need *a* host to
 * run the runner. Guard: if the leased tab isn't on an http(s) page, navigate it
 * to the site landing (same URL the pool's open() uses) before injecting.
 * Best-effort — if it can't recover, the execute() below surfaces the clear error.
 * See adapter-hot-plug.md §10.36. */
async function ensureInjectableTab(tabId: number, site: string, domain?: string): Promise<void> {
  // PROBE actual injectability rather than guessing from the URL: a leased tab can
  // be un-injectable for reasons a scheme check misses — Chrome discarded it to
  // save memory, it's on an error page, or it's a junk tab from a degraded pool
  // (e.g. heavy bridge use that never reaps) — and userScripts.execute then fails
  // "Cannot access contents of the page". When it's not injectable, navigate it to
  // a fresh site landing first. Self-heals the case where the pool hands back a
  // bad tab instead of failing the call (§10.36 / §10.37).
  if (await isLikelyInjectable(tabId)) return;
  const landing = SITE_LANDING_URL[site] ?? (domain ? `https://${domain}/` : `https://${site}.com`);
  log('dispatcher', `leased tab=${tabId} not injectable — navigating to ${landing} before inject`);
  try {
    await chrome.tabs.update(tabId, { url: landing });
    await waitForTabComplete(tabId, 30_000);
  } catch (e) {
    warn('dispatcher', `ensureInjectableTab: recovery navigate failed (continuing): ${msgOf(e)}`);
  }
}

async function executeAdapterInner(
  opts: {
    tool: string;
    args: Record<string, unknown>;
  },
  secrets: SecretMap = {},
): Promise<ToolExecResult> {
  const t0 = Date.now();
  const adapter = lookupAdapter(opts.tool);
  if (!adapter) {
    return failed(t0, `tool not found: ${opts.tool}`, 'tool_not_found');
  }

  // Validate args BEFORE we burn a tab/CDP attach on a guaranteed-broken
  // call. Models periodically guess arg names from URL patterns or help
  // text (e.g. sending `keyword` when the schema wants `query`); when that
  // happens we want a fast, structured "wrong arg names" error so the
  // model self-corrects on its next iteration.
  const argError = validateArgs(adapter, opts.args ?? {});
  if (argError) {
    return failed(t0, argError, 'generic');
  }

  // Installed func adapters (Phase B): the captured def has neither a live
  // `func` (sandbox eval stripped the closure) NOR a pipeline — only the
  // verbatim source on `_userScriptSource`. Route to the userScripts runner,
  // which evals the source in the page world to recover the closure. Must be
  // checked BEFORE the pipeline/no-pipeline split below (otherwise we'd fail
  // with "no func and no pipeline" for every installed func adapter).
  const installedFuncSource = (adapter as { _userScriptSource?: string })._userScriptSource;
  if (installedFuncSource) {
    let lease: TabLease;
    try {
      lease = await sitePool.acquire(baseSite(adapter.site), adapter.domain);
    } catch (e) {
      return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
    }
    try {
      const tabId = lease.tabId;
      // Guard against a degraded pool handing back a non-injectable tab (§10.36).
      await ensureInjectableTab(tabId, baseSite(adapter.site), adapter.domain);
      await humanPace(`tab:${tabId}`);
      log('dispatcher', `executing ${opts.tool} on tab=${tabId} (installed func via userScripts)`, {
        args: opts.args,
      });
      const page = await createPageShim(tabId);
      try {
        // Env injection: hand the adapter exactly the vault secrets its source
        // references via `process.env.NAME` (scope-checked). Empty for adapters
        // that read no env — most of them. The model never sees these values.
        const env = resolveEnvForSource(installedFuncSource, adapter.site, secrets);
        const r = await runInstalledFuncAdapter({
          tabId,
          page,
          source: installedFuncSource,
          site: adapter.site,
          name: adapter.name,
          kwargs: withArgDefaults(adapter, opts.args ?? {}),
          env,
        });
        log('dispatcher', `userScripts result ${opts.tool}`, {
          ok: r.ok,
          durationMs: Date.now() - t0,
        });
        if (r.ok) return { ok: true, result: r.value, durationMs: Date.now() - t0 };
        return failed(t0, r.error, 'generic');
      } catch (e) {
        return classifyError(t0, e, tabId);
      } finally {
        try {
          await page.detach();
        } catch (e) {
          warn('dispatcher', 'page.detach failed (ignored)', e);
        }
      }
    } finally {
      lease.release();
    }
  }

  // opencli pipeline-only adapters (no func, declarative `pipeline`). Two
  // sub-paths:
  //   (a) pure HTTP+transform (hackernews/coingecko/binance/…) — no tab, no
  //       CDP, no anti-bot pacing. SW `fetch` bypasses CORS via host_permissions.
  //   (b) has `navigate`/`evaluate` steps (zhihu/bilibili/douban/… — sites
  //       whose data lives behind in-page JS or cookied APIs only the page
  //       can call). Same lifecycle as a func adapter: pace → open tab →
  //       PageShim → run → detach. The pipeline engine consumes options.page
  //       for those steps and runs the rest in-SW.
  const pipeline = (adapter as { pipeline?: unknown }).pipeline;
  if (typeof adapter.func !== 'function') {
    if (!Array.isArray(pipeline) || pipeline.length === 0) {
      return failed(t0, `${opts.tool} cannot run: no func and no pipeline.`, 'generic');
    }
    const args = withArgDefaults(adapter, opts.args ?? {});
    const needsPage = pipelineNeedsPage(pipeline);
    if (!needsPage) {
      log('dispatcher', `executing ${opts.tool} (pipeline, ${pipeline.length} steps, tab-less)`, {
        args,
      });
      try {
        const { rows } = await runPipeline(pipeline as Pipeline, { args });
        log('dispatcher', `success ${opts.tool}`, {
          rows: rows.length,
          durationMs: Date.now() - t0,
        });
        return { ok: true, result: rows, durationMs: Date.now() - t0 };
      } catch (e) {
        return classifyError(t0, e);
      }
    }

    // Page-driven pipeline.
    let lease: TabLease;
    try {
      lease = await sitePool.acquire(baseSite(adapter.site), adapter.domain);
    } catch (e) {
      return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
    }
    try {
      const tabId = lease.tabId;
      await humanPace(`tab:${tabId}`);
      log(
        'dispatcher',
        `executing ${opts.tool} on tab=${tabId} (pipeline, ${pipeline.length} steps, needs page)`,
        { args },
      );
      const page = await createPageShim(tabId);
      try {
        const { rows } = await runPipeline(pipeline as Pipeline, { args }, { page });
        log('dispatcher', `success ${opts.tool}`, {
          rows: rows.length,
          durationMs: Date.now() - t0,
        });
        return { ok: true, result: rows, durationMs: Date.now() - t0 };
      } catch (e) {
        return classifyError(t0, e, tabId);
      } finally {
        try {
          await page.detach();
        } catch (e) {
          warn('dispatcher', 'page.detach failed (ignored)', e);
        }
      }
    } finally {
      lease.release();
    }
  }

  // Site-independent ("generic") adapters manage their own tabs (open_url,
  // get_page_text, screenshot, …). Skip the pooled-tab + PageShim dance and
  // just hand them a null page; their `func` ignores it.
  if (adapter.site === 'generic') {
    // Tools that never touch a website skip the anti-bot pacing — there is
    // nobody on the other side to convince (AdapterDef.local). Kept in step
    // with core/execute-generic.ts, which is the same branch for the lean
    // shells.
    if (!adapter.local) await humanPace('generic');
    log('dispatcher', `executing ${opts.tool} (tab-less)`, { args: opts.args });
    try {
      const result = await adapter.func(null, withArgDefaults(adapter, opts.args ?? {}));
      log('dispatcher', `success ${opts.tool}`, { durationMs: Date.now() - t0 });
      return { ok: true, result, durationMs: Date.now() - t0 };
    } catch (e) {
      return classifyError(t0, e);
    }
  }

  // Site func adapter — lease an EXCLUSIVE tab from the per-site pool. Pass the
  // adapter's declared `domain` (opencli field) so adapters from sites we have
  // no hardcoded mapping for still open at the right host instead of the
  // `https://<site>.com` guess.
  let lease: TabLease;
  try {
    lease = await sitePool.acquire(baseSite(adapter.site), adapter.domain);
  } catch (e) {
    return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
  }
  try {
    const tabId = lease.tabId;
    await humanPace(`tab:${tabId}`);
    log('dispatcher', `executing ${opts.tool} on tab=${tabId}`, { args: opts.args });
    const page = await createPageShim(tabId);
    try {
      const result = await adapter.func(page, withArgDefaults(adapter, opts.args ?? {}));
      log('dispatcher', `success ${opts.tool}`, { durationMs: Date.now() - t0 });
      return { ok: true, result, durationMs: Date.now() - t0 };
    } catch (e) {
      return classifyError(t0, e, tabId);
    } finally {
      try {
        await page.detach();
      } catch (e) {
        warn('dispatcher', 'page.detach failed (ignored)', e);
      }
    }
  } finally {
    lease.release();
  }
}

// ── Per-site tab pool (parallel-execution v3) ──────────────────────────────
// Chrome-backed tab operations behind the pool's TabOps seam. `site` here is
// already namespace-stripped (baseSite) by the dispatcher, so the hardcoded
// landing/query maps and the `https://<site>.com` guess resolve to the real
// website — identical to the un-prefixed install.
const tabOps: TabOps = {
  async findExisting(site, domain) {
    // Reuse priority: hardcoded query patterns → `*://<domain>/*`.
    // Only reuse tabs inside the agent window — never hijack the user's own tabs.
    // AWAIT window resolution: after an MV3 SW restart getAgentWindowId() is
    // undefined until ensureAgentWindowId() recovers it, and reading it sync here
    // would make us skip the window's already-open tabs and open duplicates
    // (orphan pile-up + a chance of leasing a not-yet-ready tab). See §10.36.
    let wid: number;
    try {
      wid = await ensureAgentWindowId();
    } catch {
      return undefined;
    }
    const patterns = SITE_QUERY_URL[site] ?? (domain ? [`*://${domain}/*`] : undefined);
    if (!patterns) return undefined;
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({ url: patterns, windowId: wid });
    } catch {
      return undefined; // agent window vanished mid-query → nothing to reuse
    }
    const usable = tabs.find((t) => typeof t.id === 'number');
    if (usable && usable.id !== undefined) {
      log('dispatcher', `reusing agent-window ${site} tab=${usable.id} in pool`);
      return usable.id;
    }
    return undefined;
  },
  async open(site, domain) {
    // Landing URL priority: hardcoded map → adapter's opencli `domain` → guess.
    const landing =
      SITE_LANDING_URL[site] ?? (domain ? `https://${domain}/` : `https://${site}.com`);
    log('dispatcher', `opening new ${site} pool tab: ${landing}`);
    const tab = await createAgentTab(landing);
    if (typeof tab.id !== 'number') throw new Error('createAgentTab returned no id');
    await adoptTab(tab.id); // agent-controlled → tracked + Web Agent group
    void poolReaper.note(tab.id); // durable record so the reaper survives an SW restart
    // 45s: heavy SPAs blow the old 30s budget on a cold load — measured on real
    // machine: claude.ai 25.3s (barely passed), chatgpt.com >30s (failed with
    // "tab-load timeout"). 45s keeps a fast-fail for dead sites while letting
    // the heavyweights finish. See docs/tests/findings.md (chatgpt observations).
    await waitForTabComplete(tab.id, 45_000);
    return tab.id;
  },
  async isAlive(tabId) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
  async close(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* already closed — fine */
    }
  },
};

const sitePool = new SiteTabPool(tabOps, POOL_MAX_PER_SITE);

// Durable pool-created tab tracking (survives an MV3 SW restart) — see
// tools/pool-reaper.ts for why the ids have to live outside the pool.
const poolReaper = createPoolReaper(sitePool, 'web:poolCreatedTabs');

/** Close idle (free, pool-opened) site tabs — call when all agent work is done
 *  so background tabs the dispatcher opened don't pile up. Never closes the
 *  user's own/adopted tabs or in-use leases. Returns the count closed. */
export function reapPoolTabs(): Promise<number> {
  return poolReaper.reap();
}

// Prune closed tabs from the pool: a freed slot lets a queued waiter open a
// replacement, and we never hand out a tab the user just closed. Guarded so this
// SW-only module stays importable in tests (no `chrome` global there).
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    sitePool.forget(tabId);
    void poolReaper.forget(tabId); // keep the durable set in sync on any close
  });
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Tab may have already completed; check eagerly.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') done(true);
      })
      .catch(() => {});

    function done(ok: boolean) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (ok) resolve();
      else reject(new Error('tab-load timeout'));
    }
  });
}

function classifyError(t0: number, e: unknown, tabId?: number): ToolExecResult {
  if (e instanceof RateLimitedError) {
    logError('dispatcher', 'RateLimitedError', {
      domain: e.domain,
      redirectedUrl: e.redirectedUrl,
    });
    return {
      ok: false,
      error: `Rate-limited at ${e.domain} (redirected to ${e.redirectedUrl}). Do not retry; wait 15-30 minutes and try again.`,
      errorKind: 'rate_limited',
      durationMs: Date.now() - t0,
    };
  }
  if (e instanceof AuthRequiredError) {
    return {
      ok: false,
      error: `Authentication required at ${e.domain}: ${e.message}`,
      errorKind: 'auth_required',
      tabId,
      authDomain: e.domain,
      durationMs: Date.now() - t0,
    };
  }
  if (e instanceof EmptyResultError) {
    return {
      ok: false,
      error: `No results from ${e.source}: ${e.message}`,
      errorKind: 'empty',
      durationMs: Date.now() - t0,
    };
  }
  return failed(t0, msgOf(e), 'generic');
}

function failed(t0: number, error: string, kind: ToolExecResult['errorKind']): ToolExecResult {
  return { ok: false, error, errorKind: kind, durationMs: Date.now() - t0 };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Merge an adapter's declared arg defaults under the caller-supplied args.
 * opencli applies declared defaults during CLI arg coercion, so ported adapters
 * (func AND pipeline) are written assuming the default is already in `kwargs` /
 * `args` — e.g. bilibili ranking does `slice(0, Number(kwargs.limit))`, which is
 * `slice(0, NaN) === []` when `limit` is omitted and undefaulted (F-13). Applied
 * on every execution path (func + pipeline) so an omitted optional arg behaves as
 * its declared default, not undefined. */
function withArgDefaults(
  adapter: AdapterDef,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of adapter.args ?? []) {
    if (a.default !== undefined) out[a.name] = a.default;
  }
  return { ...out, ...args };
}

/** Check the model's `args` against the adapter's declared schema.
 *
 * Strict on missing required args (the call would fail anyway — fail fast
 * with a clear message). Lenient on unknown extras: we keep them out of
 * the way (adapters ignore properties they don't read) but call them out
 * in the error message so the model notices it likely misnamed a
 * required field.
 *
 * Returns null if validation passes, otherwise a multi-line error string
 * suitable to feed back as the tool result. */
function validateArgs(adapter: AdapterDef, args: Record<string, unknown>): string | null {
  const argDefs = adapter.args ?? [];
  const expectedNames = new Set(argDefs.map((a) => a.name));
  const provided = Object.keys(args);
  const unknown = provided.filter((p) => !expectedNames.has(p));
  const missing = argDefs.filter((a) => a.required && !(a.name in args)).map((a) => a.name);

  if (missing.length === 0 && unknown.length === 0) return null;
  // Unknown-only (no missing required) is tolerable — just warn in logs
  // and let the adapter handle it. The user-visible bug in question is
  // "missing required because model used wrong name", so we focus on
  // that case.
  if (missing.length === 0) {
    warn('dispatcher', `${adapter.site}__${adapter.name} got unknown args (ignored)`, {
      unknown,
    });
    return null;
  }

  const toolName = `${adapter.site}__${adapter.name}`;
  const expectedDoc = argDefs
    .map((a) => {
      const type = a.type ?? 'string';
      const flag = a.required ? 'required' : 'optional';
      const def = a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : '';
      const help = a.help ? ` — ${a.help}` : '';
      return `  - ${a.name} (${type}, ${flag})${def}${help}`;
    })
    .join('\n');

  const lines: string[] = [
    `Argument error — ${toolName} could not run.`,
    `Missing required arguments: ${missing.map((n) => `"${n}"`).join(', ')}`,
  ];
  if (unknown.length > 0) {
    lines.push(
      `You passed unrecognized arguments ${unknown.map((n) => `"${n}"`).join(', ')} — likely a misspelled name; fix against the schema:`,
    );
  } else {
    lines.push('Schema:');
  }
  lines.push(expectedDoc);
  lines.push('');
  lines.push('Call again with the correct argument names. If unsure what an argument means, run `describe_tool` first for the full spec.');
  return lines.join('\n');
}
