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

import { registerCommand, unregister as registryUnregister } from '@base/runtime/registry.js';
import { validatePipeline } from '../runtime/opencli/pipeline';
import {
  putInstalled,
  getInstalled,
  listInstalled,
  deleteInstalled,
  setInstalledEnabled,
  setInstalledVerify,
  type InstalledAdapter,
  type CapturedDef,
} from './installed-store';
import { clearHealth } from './adapter-health-store';
import { log, warn } from '@base/runtime/log';
import { isUserScriptsApiAvailable } from '../userscript/sw-runner';
import { resolveBaseUrl } from '@base/core/marketplace';
import { toExploredSite } from './namespace';

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
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string; healedFrom?: 'marketplace' };
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
export async function installFromCaptured(
  req: InstallRequest,
  now: number,
): Promise<InstallResult> {
  const { source, origin } = req;
  if (!Array.isArray(req.defs) || req.defs.length === 0) {
    return {
      ok: false,
      registered: 0,
      deferredFunc: 0,
      deferredUnsupported: 0,
      error: 'no adapter definitions captured',
    };
  }
  // Self-explored adapters land in a separate namespace (prefixed `site`) so they
  // never collide with the marketplace pool for the same website. Marketplace /
  // manual installs keep their authored site. See ./namespace + docs §15.
  const defs =
    origin.type === 'explore'
      ? req.defs.map((d) => ({ ...d, site: toExploredSite(d.site) }))
      : req.defs;
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
  if (priorDefs) {
    unregisterDefs(priorDefs);
    // A re-install replaces the source — old run-health is stale (H1: a heal /
    // upstream re-install starts the adapter fresh). Best-effort.
    void clearHealth(id);
  }
  const prior = await getInstalled(id);

  const kind = classifyKind(defs);
  const row: InstalledAdapter = {
    id,
    title:
      defs.length === 1
        ? `${defs[0].site}/${defs[0].name}`
        : `${defs[0].site} (${defs.length} cmds)`,
    source,
    defs,
    kind,
    enabled: true,
    installedAt: prior?.installedAt ?? now,
    updatedAt: now,
    origin,
    // Explore-synthesized adapters start "untested"; verify ("test-run") flips it.
    ...(origin.type === 'explore' ? { verifyStatus: 'untested' as const } : {}),
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

/**
 * Explore v2: register captured defs into the live registry WITHOUT persisting
 * to the installed-store — makes a freshly-synthesized adapter session-callable
 * (smoke-test + reuse within the explore session) while the PERMANENT install
 * stays the user's explicit install click (installFromCaptured). Re-registering the
 * same site/name overwrites (repair). Returns how many became runnable now;
 * func defs need "Allow user scripts" or they stay unregistered. NOT tracked in
 * liveDefs (they're ephemeral — gone on SW restart, exactly the intent).
 */
export function registerSessionDefs(defs: CapturedDef[], source: string): number {
  return registerRunnable(defs, source);
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
  if (adapters > 0)
    log('install', `restored ${adapters} installed adapters (${commands} commands)`);
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

/** Record an explore adapter's verify ("test-run") result (passed/failed + note). */
export async function markVerified(
  id: string,
  status: 'untested' | 'passed' | 'failed',
  note?: string,
): Promise<void> {
  await setInstalledVerify(id, status, note);
}

export async function listInstalledAdapters(): Promise<InstalledAdapter[]> {
  try {
    return await listInstalled();
  } catch (e) {
    warn('install', 'listInstalledAdapters failed', e);
    return [];
  }
}

/** SHA-256 hex of a UTF-8 string. Mirrors marketplace.ts's sha256Hex; inlined
 * here to keep the SW layer free of any sidepanel import. */
async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface StaleMarketAdapter {
  id: string;
  title: string;
}

/**
 * Detect installed *marketplace* adapters whose stored source has drifted from
 * the bundled catalog — i.e. the source was hand-edited + its index.json sha256
 * rotated (a common case here, since marketplace adapters are hand-maintained
 * and the user must reinstall to pick up a fix). Returns the drifted ids so the
 * SidePanel can silently re-install them from the catalog.
 *
 * Compares sha256(installed.source) against the catalog's promised sha256
 * (NOT the semver version, which is informational). Adapters no longer present
 * in the catalog are left alone (never auto-uninstalled). Best-effort: any I/O
 * failure yields an empty list (a missing/locked catalog must not block boot).
 */
export async function findStaleMarketplaceAdapters(): Promise<StaleMarketAdapter[]> {
  let rows: InstalledAdapter[];
  try {
    rows = await listInstalled();
  } catch {
    return [];
  }
  const market = rows.filter((r) => r.origin?.type === 'marketplace');
  if (market.length === 0) return [];

  let wantById: Map<string, string>;
  try {
    // Adapters live in the remote marketplace repo now (served via GitHub raw);
    // compare installed copies against that index (honoring the remoteMarketUrl
    // override) to auto-update drifted ones.
    const url = new URL('index.json', await resolveBaseUrl()).toString();
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      adapters?: { site: string; name: string; sha256: string }[];
    };
    wantById = new Map((data.adapters ?? []).map((a) => [`${a.site}/${a.name}`, a.sha256]));
  } catch {
    return [];
  }

  const stale: StaleMarketAdapter[] = [];
  for (const row of market) {
    const want = wantById.get(row.id);
    if (!want) continue; // dropped from the catalog — leave the installed copy be
    let got: string;
    try {
      got = await sha256Hex(row.source);
    } catch {
      continue;
    }
    if (got !== want) stale.push({ id: row.id, title: row.title });
  }
  if (stale.length > 0) {
    log('install', `found ${stale.length} stale marketplace adapter(s)`, {
      ids: stale.map((s) => s.id),
    });
  }
  return stale;
}
