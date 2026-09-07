/**
 * Runtime adapter install / marketplace handlers (hot-plug). The SidePanel's
 * sandbox eval's the source into serializable `defs`; the SW only consumes that
 * data (it never evals). Also the two broadcasts that keep the panel + the
 * external bridge's tool catalog in sync.
 */

import {
  installFromCaptured,
  uninstall as uninstallAdapter,
  setEnabled as setAdapterEnabled,
  listInstalledAdapters,
  registerSessionDefs,
} from '../adapters/install-manager';
import { getInstalled, type CapturedDef } from '../adapters/installed-store';
import { refreshBridgeCatalog } from './bridge-client';
import { sendToSidepanel } from '@base/background/runtime-state';
import { evalAdapterViaOffscreen } from './offscreen-eval';
import type {
  InstallAdapterReq,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  ListInstalledResp,
  InstalledAdapterSummary,
  AdaptersChangedEvt,
  AdapterBrokenEvt,
  RegisterSessionAdapterReq,
  RegisterSessionAdapterResp,
} from '../messages';

/** Persist + register an adapter the SidePanel's sandbox already eval'd into
 * captured defs. The SW never evals — it only consumes serializable data. */
export async function handleInstallAdapter(m: InstallAdapterReq) {
  const r = await installFromCaptured(
    { source: m.source, defs: m.defs, origin: m.origin },
    Date.now(),
  );
  if (r.ok) broadcastAdaptersChanged();
  return {
    type: 'INSTALL_ADAPTER_RESP' as const,
    ok: r.ok,
    id: r.id,
    title: r.title,
    registered: r.registered,
    deferredFunc: r.deferredFunc,
    deferredUnsupported: r.deferredUnsupported,
    error: r.error,
  };
}

/** Re-register raw adapter source into the LIVE registry for this session only
 * (offscreen eval → registerSessionDefs, no persist). The explore-result card's
 * verify-run uses this when its tool vanished with a SW restart — session
 * registrations are ephemeral by design, so re-create one instead of installing. */
export async function handleRegisterSessionAdapter(
  m: RegisterSessionAdapterReq,
): Promise<RegisterSessionAdapterResp> {
  const type = 'REGISTER_SESSION_ADAPTER_RESP' as const;
  const evaled = await evalAdapterViaOffscreen(m.source);
  if (!evaled.ok || !evaled.defs.length) {
    return { type, ok: false, error: evaled.error ?? 'source registered no cli() adapter' };
  }
  const registered = registerSessionDefs(evaled.defs as CapturedDef[], m.source);
  if (registered === 0) {
    return {
      type,
      ok: false,
      error:
        'A func-type adapter can only be registered and run after enabling this extension\'s "Allow user scripts" switch at chrome://extensions.',
    };
  }
  return { type, ok: true, registered };
}

export async function handleUninstallAdapter(m: UninstallAdapterReq): Promise<void> {
  await uninstallAdapter(m.id);
  broadcastAdaptersChanged();
}

export async function handleSetAdapterEnabled(m: SetAdapterEnabledReq): Promise<void> {
  await setAdapterEnabled(m.id, m.enabled);
  broadcastAdaptersChanged();
}

export async function handleListInstalled(): Promise<ListInstalledResp> {
  const rows = await listInstalledAdapters();
  const adapters: InstalledAdapterSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    enabled: r.enabled,
    commandCount: r.defs.length,
    installedAt: r.installedAt,
    origin: r.origin,
    verifyStatus: r.verifyStatus,
    verifyNote: r.verifyNote,
    description: r.defs.find((d) => d.description)?.description,
  }));
  return { type: 'LIST_INSTALLED_RESP', adapters };
}

/** Tell the SidePanel the installed set changed so it refreshes its lists.
 * (The agent's tool whitelist is read live from the registry, so no extra
 * push is needed there.) */
export function broadcastAdaptersChanged(): void {
  sendToSidepanel({ type: 'ADAPTERS_CHANGED' } satisfies AdaptersChangedEvt);
  refreshBridgeCatalog(); // keep the external bridge's tool catalog in sync (T7 P2)
}

/** H1-P2c: an installed adapter drifted into "broken" → tell the SidePanel so it
 * can offer a heal. Only for INSTALLED adapters (heal needs their source). */
export async function broadcastAdapterBroken(id: string, lastError?: string): Promise<void> {
  const inst = await getInstalled(id).catch(() => null);
  if (!inst) return;
  const sep = id.indexOf('/');
  const tool = sep < 0 ? id : `${id.slice(0, sep)}__${id.slice(sep + 1)}`;
  sendToSidepanel({
    type: 'ADAPTER_BROKEN',
    id,
    tool,
    error: lastError,
    origin: inst.origin,
  } satisfies AdapterBrokenEvt);
}
