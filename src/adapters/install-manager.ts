/**
 * Install manager — service-worker side orchestration for runtime-installed
 * adapters.
 *
 * IMPORTANT: this module does NOT eval anything. Source is eval'd in the
 * sandboxed iframe (hosted by the SidePanel); the SidePanel forwards the
 * already-captured, serializable definitions here. So the SW stays eval-free
 * and MV3-CSP-clean.
 *
 * Phase A scope: pipeline-type adapters are fully installable + runnable
 * (their captured defs are pure data → registered into the registry → run via
 * runtime/opencli/pipeline.ts). func-type defs are persisted and listed but
 * NOT registered for execution (Phase B will re-eval their source in a venue
 * that can host the closure). They surface in the UI as "needs func support".
 */

import {
  registerCommand,
  unregister as registryUnregister,
} from '../runtime/registry.js';
import { validatePipeline } from '../runtime/opencli/pipeline';
import {
  putInstalled,
  getInstalled,
  listInstalled,
  deleteInstalled,
  setInstalledEnabled,
  type InstalledAdapter,
  type CapturedDef,
} from './installed-store';
import { log, warn } from '../runtime/log';
import { isUserScriptsApiAvailable } from '../userscript/sw-runner';

/**
 * In-memory mirror of which captured defs each installed adapter put into the
 * live registry THIS service-worker lifetime. The IndexedDB store is the
 * persistence layer; this map is the live truth used to unregister cleanly on
 * uninstall/disable WITHOUT depending on a DB read succeeding (it also keeps
 * registry mutations correct in environments where IDB is unavailable, e.g.
 * unit tests). Rebuilt on boot from the store.
 */
const liveDefs = new Map<string, CapturedDef[]>();

export interface InstallRequest {
  source: string;
  defs: CapturedDef[];
  origin: { type: 'marketplace' | 'manual'; url?: string };
}

export interface InstallResult {
  ok: boolean;
  id?: string;
  title?: string;
  /** How many defs became runnable now. */
  registered: number;
  /** Defs persisted but not runnable because they are `func`-type (Phase B). */
  deferredFunc: number;
  /** Defs persisted but not runnable because they're `pipeline` using a step
   * the engine doesn't support yet (e.g. wait/click/fill — not navigate/
   * evaluate/select, which DO work). Distinct UX from deferredFunc so the user
   * knows it's a missing feature, not pending the Phase B venue. */
  deferredUnsupported: number;
  error?: string;
}

/** Aggregate the per-def classification into the source-level `kind`. */
export function classifyKind(defs: CapturedDef[]): InstalledAdapter['kind'] {
  if (defs.length === 0) return 'unknown';
  const kinds = new Set(defs.map((d) => d.kind));
  if (kinds.size === 1) return [...kinds][0] as InstalledAdapter['kind'];
  if (kinds.has('pipeline') && kinds.has('func')) return 'mixed';
  // pipeline+unknown or func+unknown → report the meaningful one
  if (kinds.has('func')) return 'func';
  if (kinds.has('pipeline')) return 'pipeline';
  return 'unknown';
}

/** Is a def runnable NOW given the runtime's capabilities?
 *
 *   pipeline → runnable iff the pipeline parses + only uses supported steps.
 *   func     → runnable iff chrome.userScripts is available (Phase B runner).
 *              We still need user to enable "Allow user scripts" — the runner
 *              gives a clear error at call time if the toggle is off — but
 *              that's not something we can pre-check synchronously.
 *
 * In node tests there's no `chrome` global, so func defs stay deferred and
 * the existing test expectations hold. */
export function isRunnableNow(def: CapturedDef): boolean {
  if (def.kind === 'func') return isUserScriptsApiAvailable();
  if (def.kind !== 'pipeline') return false;
  if (!Array.isArray(def.pipeline) || def.pipeline.length === 0) return false;
  return validatePipeline(def.pipeline).length === 0;
}

/** Register one captured def into the live registry, tagged so it can be told
 * apart from built-ins and cleanly unregistered later. For func defs we also
 * attach the verbatim source so the dispatcher can hand it to the userScripts
 * runner (which evals it in the page world to recover the closure). */
function registerDef(def: CapturedDef, source: string): void {
  const entry: Record<string, unknown> = { ...def, _installed: true };
  if (def.kind === 'func') entry._userScriptSource = source;
  registerCommand(entry);
}

/** Register all runnable defs of an installed adapter. Returns count. */
function registerRunnable(defs: CapturedDef[], source: string): number {
  let n = 0;
  for (const d of defs) {
    if (isRunnableNow(d)) {
      registerDef(d, source);
      n++;
    }
  }
  return n;
}

/** Unregister every def of an installed adapter from the live registry. */
function unregisterDefs(defs: CapturedDef[]): void {
  for (const d of defs) registryUnregister(d.site, d.name);
}

function deriveId(defs: CapturedDef[]): string | null {
  const first = defs[0];
  return first ? `${first.site}/${first.name}` : null;
}

/**
 * Install from already-captured (sandbox-eval'd) defs. Validates, persists,
 * and registers the runnable (pipeline) ones. Idempotent on (id): a re-install
 * replaces the previous registration + row.
 */
export async function installFromCaptured(req: InstallRequest, now: number): Promise<InstallResult> {
  const { defs, source, origin } = req;
  if (!Array.isArray(defs) || defs.length === 0) {
    return {
      ok: false,
      registered: 0,
      deferredFunc: 0,
      deferredUnsupported: 0,
      error: 'no adapter definitions captured',
    };
  }
  const id = deriveId(defs);
  if (!id) {
    return {
      ok: false,
      registered: 0,
      deferredFunc: 0,
      deferredUnsupported: 0,
      error: 'captured def missing site/name',
    };
  }

  // Replace any prior registration of the same id's defs before re-adding.
  // Prefer the live map (always accurate); fall back to the persisted row.
  const priorDefs = liveDefs.get(id) ?? (await getInstalled(id))?.defs;
  if (priorDefs) unregisterDefs(priorDefs);
  const prior = await getInstalled(id);

  const kind = classifyKind(defs);
  const row: InstalledAdapter = {
    id,
    title: defs.length === 1 ? `${defs[0].site}/${defs[0].name}` : `${defs[0].site} (${defs.length} cmds)`,
    source,
    defs,
    kind,
    enabled: true,
    installedAt: prior?.installedAt ?? now,
    updatedAt: now,
    origin,
  };
  await putInstalled(row);

  const registered = registerRunnable(defs, source);
  liveDefs.set(id, defs);
  let deferredFunc = 0;
  let deferredUnsupported = 0;
  for (const d of defs) {
    if (isRunnableNow(d)) continue;
    if (d.kind === 'func') deferredFunc++;
    else deferredUnsupported++;
  }
  log('install', `installed ${id}`, { kind, registered, deferredFunc, deferredUnsupported });
  return { ok: true, id, title: row.title, registered, deferredFunc, deferredUnsupported };
}

/** On SW boot: register the runnable defs of every ENABLED installed adapter. */
export async function loadInstalledOnBoot(): Promise<{ adapters: number; commands: number }> {
  const rows = await listInstalled();
  let adapters = 0;
  let commands = 0;
  for (const row of rows) {
    if (!row.enabled) continue;
    const n = registerRunnable(row.defs, row.source);
    liveDefs.set(row.id, row.defs);
    if (n > 0) adapters++;
    commands += n;
  }
  if (adapters > 0) log('install', `restored ${adapters} installed adapters (${commands} commands)`);
  return { adapters, commands };
}

export async function uninstall(id: string): Promise<{ ok: boolean }> {
  // Unregister from the live map first (DB-read-independent), then persist.
  const defs = liveDefs.get(id) ?? (await getInstalled(id))?.defs;
  if (defs) unregisterDefs(defs);
  liveDefs.delete(id);
  await deleteInstalled(id);
  log('install', `uninstalled ${id}`);
  return { ok: true };
}

export async function setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }> {
  // Need the defs to (un)register and the source to attach for func defs.
  // Always read the row (the live map doesn't carry source).
  const row = await getInstalled(id);
  const defs = liveDefs.get(id) ?? row?.defs;
  if (!defs || !row) return { ok: false };
  if (enabled) registerRunnable(defs, row.source);
  else unregisterDefs(defs);
  await setInstalledEnabled(id, enabled);
  log('install', `${enabled ? 'enabled' : 'disabled'} ${id}`);
  return { ok: true };
}

export async function listInstalledAdapters(): Promise<InstalledAdapter[]> {
  try {
    return await listInstalled();
  } catch (e) {
    warn('install', 'listInstalledAdapters failed', e);
    return [];
  }
}
