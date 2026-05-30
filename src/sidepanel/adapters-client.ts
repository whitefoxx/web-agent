/**
 * SidePanel client for the adapter install / marketplace flow.
 *
 * Ties together: (1) the sandbox host (eval source → captured defs), and
 * (2) the SW messages (persist + register, list, uninstall, enable). The UI
 * (Adapters.tsx) calls these; this module keeps the wiring out of the view.
 */

import { evalAdapterInSandbox } from './sandbox-host';
import type {
  InstallAdapterReq,
  InstallAdapterResp,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  ListInstalledReq,
  ListInstalledResp,
  InstalledAdapterSummary,
} from '../connectors/messages';

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
export async function installAdapterFromSource(
  source: string,
  origin: { type: 'marketplace' | 'manual'; url?: string },
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

export async function uninstallAdapter(id: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'UNINSTALL_ADAPTER', id } satisfies UninstallAdapterReq);
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
