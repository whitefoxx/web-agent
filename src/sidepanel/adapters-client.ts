/**
 * SidePanel client for the adapter install / marketplace flow.
 *
 * Ties together: (1) the sandbox host (eval source → captured defs), and
 * (2) the SW messages (persist + register, list, uninstall, enable). The UI
 * (Adapters.tsx) calls these; this module keeps the wiring out of the view.
 */

import { evalAdapterInSandbox } from './sandbox-host';
import { fetchMarketIndex, fetchAdapterSource, entryId, type MarketIndex } from '@base/core/marketplace';
import type {
  InstallAdapterReq,
  InstallAdapterResp,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  ListInstalledReq,
  ListInstalledResp,
  GetAdapterSourceReq,
  GetAdapterSourceResp,
  GetAdapterCommandsReq,
  GetAdapterCommandsResp,
  AdapterCommand,
  InstalledAdapterSummary,
  ListStaleAdaptersReq,
  ListStaleAdaptersResp,
  StaleAdapterInfo,
  LoadAdapterReq,
  LoadAdapterResp,
  RegisterSessionAdapterReq,
  RegisterSessionAdapterResp,
} from '../messages';

export interface InstallOutcome {
  ok: boolean;
  id?: string;
  title?: string;
  registered?: number;
  /** Func-type defs persisted but not yet runnable (Phase B). */
  deferredFunc?: number;
  /** Pipeline defs using a step the engine doesn't support yet. */
  deferredUnsupported?: number;
  error?: string;
}

/**
 * Install an adapter from raw source: eval in the sandbox, then hand the
 * captured defs to the SW to persist + register. `origin` records where the
 * source came from (marketplace entry url, or manual paste).
 */
/** A drifted adapter targeted for heal (H1-P2): re-install in place under its
 * ORIGINAL id, as a local override (origin manual → no `my-` prefix, exempt
 * from marketplace sha-drift) unless it was already explore-origin. */
export interface HealTarget {
  id: string;
  site: string;
  name: string;
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' };
}

export async function installAdapterFromSource(
  source: string,
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' },
): Promise<InstallOutcome> {
  const evaled = await evalAdapterInSandbox(source);
  if (!evaled.ok) {
    return { ok: false, error: evaled.error ?? 'failed to evaluate adapter source' };
  }
  if (evaled.defs.length === 0) {
    return { ok: false, error: 'source did not register any adapter via cli()' };
  }
  const req: InstallAdapterReq = { type: 'INSTALL_ADAPTER', source, defs: evaled.defs, origin };
  try {
    const resp = (await chrome.runtime.sendMessage(req)) as InstallAdapterResp | undefined;
    if (!resp) return { ok: false, error: 'no response from service worker' };
    return {
      ok: resp.ok,
      id: resp.id,
      title: resp.title,
      registered: resp.registered,
      deferredFunc: resp.deferredFunc,
      deferredUnsupported: resp.deferredUnsupported,
      error: resp.error,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listInstalled(): Promise<InstalledAdapterSummary[]> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'LIST_INSTALLED',
    } satisfies ListInstalledReq)) as ListInstalledResp | undefined;
    return resp?.adapters ?? [];
  } catch {
    return [];
  }
}

/** Fetch one installed adapter's full source (view / download). Null if absent. */
export async function getAdapterSource(id: string): Promise<string | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'GET_ADAPTER_SOURCE',
      id,
    } satisfies GetAdapterSourceReq)) as GetAdapterSourceResp | undefined;
    return resp?.source ?? null;
  } catch {
    return null;
  }
}

/** Fetch an installed adapter's commands + arg schemas for manual run (T6a). */
export async function getAdapterCommands(id: string): Promise<AdapterCommand[]> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'GET_ADAPTER_COMMANDS',
      id,
    } satisfies GetAdapterCommandsReq)) as GetAdapterCommandsResp | undefined;
    return resp?.commands ?? [];
  } catch {
    return [];
  }
}

/** Ask the SW which installed marketplace adapters have drifted from the
 * bundled catalog (sha256 mismatch). */
export async function listStaleAdapters(): Promise<StaleAdapterInfo[]> {
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'LIST_STALE_ADAPTERS',
    } satisfies ListStaleAdaptersReq)) as ListStaleAdaptersResp | undefined;
    return resp?.stale ?? [];
  } catch {
    return [];
  }
}

/**
 * Auto-update drifted marketplace adapters: detect the stale ones (SW), then
 * re-fetch each from the catalog (sha256-verified) and re-install through the
 * sandbox — the same idempotent path as a manual reinstall, so no reload is
 * needed for the user to pick up an adapter fix. Returns the titles updated.
 * Best-effort: a per-adapter failure is swallowed (retried on the next open).
 */
export async function reconcileStaleAdapters(): Promise<string[]> {
  const stale = await listStaleAdapters();
  if (stale.length === 0) return [];
  let idx: MarketIndex;
  try {
    idx = await fetchMarketIndex({ forceFresh: true }); // sha-verified source fetch below
  } catch {
    return [];
  }
  const byId = new Map(idx.adapters.map((a) => [entryId(a), a]));
  const updated: string[] = [];
  for (const s of stale) {
    const entry = byId.get(s.id);
    if (!entry) continue;
    try {
      const src = await fetchAdapterSource(entry);
      const r = await installAdapterFromSource(src, {
        type: 'marketplace',
        url: `bundled:${s.id}`,
      });
      if (r.ok) updated.push(s.title);
    } catch {
      /* leave it stale; next sidepanel open retries */
    }
  }
  return updated;
}

export async function uninstallAdapter(id: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'UNINSTALL_ADAPTER',
      id,
    } satisfies UninstallAdapterReq);
  } catch {
    /* best effort */
  }
}

export async function setAdapterEnabled(id: string, enabled: boolean): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'SET_ADAPTER_ENABLED',
      id,
      enabled,
    } satisfies SetAdapterEnabledReq);
  } catch {
    /* best effort */
  }
}

/** Re-register raw adapter source into the live registry for THIS session only
 * (SW offscreen eval → registerSessionDefs; no persist). The Explore-result card's
 * try-run fallback when its ephemeral registration died with a SW restart. */
export async function registerSessionAdapter(
  source: string,
): Promise<{ ok: boolean; registered?: number; error?: string }> {
  try {
    const r = (await chrome.runtime.sendMessage({
      type: 'REGISTER_SESSION_ADAPTER',
      source,
    } satisfies RegisterSessionAdapterReq)) as RegisterSessionAdapterResp | undefined;
    return r
      ? { ok: r.ok, registered: r.registered, error: r.error }
      : { ok: false, error: 'No response' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Load a marketplace adapter for the session (no install) so it can be run from
 * the marketplace tab. Returns the loaded commands (or an error). */
export async function loadAdapter(
  site: string,
  name: string,
): Promise<{ ok: boolean; commands?: AdapterCommand[]; error?: string }> {
  try {
    const r = (await chrome.runtime.sendMessage({
      type: 'LOAD_ADAPTER',
      site,
      name,
    } satisfies LoadAdapterReq)) as LoadAdapterResp | undefined;
    return r ? { ok: r.ok, commands: r.commands, error: r.error } : { ok: false, error: 'No response' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
