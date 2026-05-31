/**
 * Tool dispatcher — finds the adapter for a `site__name` tool, ensures a
 * target tab exists for the adapter's site, attaches CDP via PageShim, runs
 * the adapter, then detaches.
 *
 * Lives in the service worker. The api-engine calls into this via the
 * `EngineContext.executeTool` interface.
 */

import { lookupAdapter, type AdapterDef } from './manifest';
import { runPipeline, pipelineNeedsPage, type Pipeline } from '../runtime/opencli/pipeline';
import { createPageShim } from '../runtime/page';
import { log, warn, error as logError } from '../runtime/log';
import { RateLimitedError, AuthRequiredError, EmptyResultError } from '../runtime/errors.js';
import { runInstalledFuncAdapter } from '../userscript/sw-runner';

export interface ToolExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  errorKind?: 'rate_limited' | 'auth_required' | 'empty' | 'tool_not_found' | 'tab' | 'generic';
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

/** Inter-call pacing per-site (anti-bot defence). When the agent fires
 * several adapters back-to-back (e.g. `xiaohongshu__search` followed by
 * many `xiaohongshu__note` calls), we want each subsequent call to wait
 * a human-ish amount of time before kicking off.
 *
 * The PageShim itself already adds 0.8-1.8s before each navigation and
 * 1.2-2.4s after, but that only kicks in if the adapter actually calls
 * `page.goto`. The dispatcher-level pacing here closes that loophole and
 * also enforces a hard minimum gap between consecutive calls to the same
 * site — even if the adapter is purely read-from-current-page. */
const MIN_INTERVAL_PER_SITE_MS = 2500;
const HUMAN_PAUSE_MIN_MS = 600;
const HUMAN_PAUSE_MAX_MS = 1800;

const lastCallTsPerSite = new Map<string, number>();

async function humanPaceForSite(site: string): Promise<void> {
  const now = Date.now();
  const last = lastCallTsPerSite.get(site) ?? 0;
  const elapsed = now - last;
  const jitter =
    HUMAN_PAUSE_MIN_MS + Math.floor(Math.random() * (HUMAN_PAUSE_MAX_MS - HUMAN_PAUSE_MIN_MS));
  let totalWait = jitter;
  if (elapsed < MIN_INTERVAL_PER_SITE_MS) totalWait += MIN_INTERVAL_PER_SITE_MS - elapsed;
  log(
    'dispatcher',
    `humanPace site=${site} sleep=${totalWait}ms (elapsed=${elapsed}ms since last)`,
  );
  await new Promise((r) => setTimeout(r, totalWait));
  lastCallTsPerSite.set(site, Date.now());
}

export async function executeAdapter(opts: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<ToolExecResult> {
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
    await humanPaceForSite(adapter.site);
    let tabId: number;
    try {
      tabId = await ensureSiteTab(adapter.site, adapter.domain);
    } catch (e) {
      return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
    }
    log(
      'dispatcher',
      `executing ${opts.tool} on tab=${tabId} (installed func via userScripts)`,
      { args: opts.args },
    );
    const page = await createPageShim(tabId);
    try {
      const r = await runInstalledFuncAdapter({
        tabId,
        page,
        source: installedFuncSource,
        site: adapter.site,
        name: adapter.name,
        kwargs: opts.args ?? {},
      });
      log('dispatcher', `userScripts result ${opts.tool}`, {
        ok: r.ok,
        durationMs: Date.now() - t0,
      });
      if (r.ok) return { ok: true, result: r.value, durationMs: Date.now() - t0 };
      return failed(t0, r.error, 'generic');
    } catch (e) {
      return classifyError(t0, e);
    } finally {
      try {
        await page.detach();
      } catch (e) {
        warn('dispatcher', 'page.detach failed (ignored)', e);
      }
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
    await humanPaceForSite(adapter.site);
    let tabId: number;
    try {
      tabId = await ensureSiteTab(adapter.site, adapter.domain);
    } catch (e) {
      return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
    }
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
      return classifyError(t0, e);
    } finally {
      try {
        await page.detach();
      } catch (e) {
        warn('dispatcher', 'page.detach failed (ignored)', e);
      }
    }
  }

  // Pause before doing anything to make the call rhythm human-ish even
  // when several adapters fire back-to-back in the same iteration.
  await humanPaceForSite(adapter.site);

  // Site-independent ("generic") adapters manage their own tabs (open_url,
  // get_page_text, screenshot, …). Skip the pre-bound site-tab + PageShim
  // dance and just hand them a null page; their `func` ignores it.
  if (adapter.site === 'generic') {
    log('dispatcher', `executing ${opts.tool} (tab-less)`, { args: opts.args });
    try {
      const result = await adapter.func(null, opts.args ?? {});
      log('dispatcher', `success ${opts.tool}`, { durationMs: Date.now() - t0 });
      return { ok: true, result, durationMs: Date.now() - t0 };
    } catch (e) {
      return classifyError(t0, e);
    }
  }

  let tabId: number;
  try {
    // Pass the adapter's declared `domain` (opencli field) so adapters from
    // sites we have no hardcoded mapping for still open at the right host
    // instead of the `https://<site>.com` guess.
    tabId = await ensureSiteTab(adapter.site, adapter.domain);
  } catch (e) {
    return failed(t0, `failed to open ${adapter.site} tab: ${msgOf(e)}`, 'tab');
  }

  log('dispatcher', `executing ${opts.tool} on tab=${tabId}`, { args: opts.args });
  const page = await createPageShim(tabId);
  try {
    const result = await adapter.func(page, opts.args ?? {});
    log('dispatcher', `success ${opts.tool}`, { durationMs: Date.now() - t0 });
    return { ok: true, result, durationMs: Date.now() - t0 };
  } catch (e) {
    return classifyError(t0, e);
  } finally {
    try {
      await page.detach();
    } catch (e) {
      warn('dispatcher', 'page.detach failed (ignored)', e);
    }
  }
}

async function ensureSiteTab(site: string, domain?: string): Promise<number> {
  // Landing URL priority: hardcoded map → adapter's opencli `domain` → guess.
  // Reuse priority: hardcoded query patterns → `*://<domain>/*`.
  const patterns = SITE_QUERY_URL[site] ?? (domain ? [`*://${domain}/*`] : undefined);
  const landing = SITE_LANDING_URL[site] ?? (domain ? `https://${domain}/` : `https://${site}.com`);

  if (patterns) {
    const tabs = await chrome.tabs.query({ url: patterns });
    const usable = tabs.find((t) => typeof t.id === 'number');
    if (usable && usable.id !== undefined) {
      log('dispatcher', `reusing existing ${site} tab=${usable.id}`);
      return usable.id;
    }
  }

  log('dispatcher', `opening new ${site} tab: ${landing}`);
  const tab = await chrome.tabs.create({ url: landing, active: false });
  if (typeof tab.id !== 'number') throw new Error('chrome.tabs.create returned no id');
  await waitForTabComplete(tab.id, 30_000);
  return tab.id;
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

function classifyError(t0: number, e: unknown): ToolExecResult {
  if (e instanceof RateLimitedError) {
    logError('dispatcher', 'RateLimitedError', {
      domain: e.domain,
      redirectedUrl: e.redirectedUrl,
    });
    return {
      ok: false,
      error: `Rate-limited at ${e.domain} (redirected to ${e.redirectedUrl}). 不要重试，等 15–30 分钟再试。`,
      errorKind: 'rate_limited',
      durationMs: Date.now() - t0,
    };
  }
  if (e instanceof AuthRequiredError) {
    return {
      ok: false,
      error: `Authentication required at ${e.domain}: ${e.message}`,
      errorKind: 'auth_required',
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
 * Pipeline expressions like `${{ args.limit }}` rely on defaults being present
 * (opencli applies them during CLI arg coercion; our func path lets adapters
 * read `kwargs` directly, but pipelines need the defaults pre-filled). */
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
    `参数错误 — ${toolName} 未能执行。`,
    `缺少必需参数: ${missing.map((n) => `"${n}"`).join(', ')}`,
  ];
  if (unknown.length > 0) {
    lines.push(
      `你传了未识别的参数 ${unknown.map((n) => `"${n}"`).join(', ')} —— 很可能写错名字了，请对照 schema 修正：`,
    );
  } else {
    lines.push('Schema:');
  }
  lines.push(expectedDoc);
  lines.push('');
  lines.push('请用正确的参数名重新调用。如果不确定参数语义，先 `describe_tool` 拿完整说明。');
  return lines.join('\n');
}
