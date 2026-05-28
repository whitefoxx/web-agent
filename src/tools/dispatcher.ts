/**
 * Tool dispatcher — finds the adapter for a `site__name` tool, ensures a
 * target tab exists for the adapter's site, attaches CDP via PageShim, runs
 * the adapter, then detaches.
 *
 * Lives in the service worker. The orchestrator calls into this via the
 * `Driver.executeTool` interface.
 */

import { lookupAdapter } from './manifest';
import { createPageShim } from '../runtime/page';
import { log, warn, error as logError } from '../runtime/log';
import { RateLimitedError, AuthRequiredError, EmptyResultError } from '../runtime/errors.js';

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

export async function executeAdapter(opts: {
  tool: string;
  args: Record<string, unknown>;
}): Promise<ToolExecResult> {
  const t0 = Date.now();
  const adapter = lookupAdapter(opts.tool);
  if (!adapter) {
    return failed(t0, `tool not found: ${opts.tool}`, 'tool_not_found');
  }

  let tabId: number;
  try {
    tabId = await ensureSiteTab(adapter.site);
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

async function ensureSiteTab(site: string): Promise<number> {
  const patterns = SITE_QUERY_URL[site];
  const landing = SITE_LANDING_URL[site] ?? `https://${site}.com`;

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
