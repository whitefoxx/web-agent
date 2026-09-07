/**
 * Adapter health monitor (roadmap H1-P1) — detect when an installed site adapter
 * is drifting / breaking, from its real run outcomes.
 *
 * Every installed-adapter invocation (SidePanel agent, bridge, manual run) passes
 * through `executeAdapter` (src/tools/dispatcher.ts); a fire-and-forget hook there
 * folds the outcome into a per-tool rolling summary kept here. The pure helpers
 * (`applyOutcome` / `computeHealthStatus`) are unit-tested; the IDB CRUD is
 * best-effort and no-ops without `indexedDB` (node tests), same as memory/notes
 * stores. Its own database (`web-agent-health`) so it never has to coordinate
 * a schema version with the shared `web-agent` DB.
 *
 * `errorKind` (from the dispatcher) drives the signal:
 *   - `empty` / `generic`          → DRIFT (selector/endpoint likely died) — counts
 *                                     toward degraded/broken; the auto-heal trigger.
 *   - `rate_limited`/`auth_required`→ BLOCKED (site-side: needs auth / anti-bot) —
 *                                     not the adapter's fault.
 *   - `tab`                        → our own infra (tab pool) — transient, ignored.
 */
import { warn } from '@base/runtime/log';

/** Subset of the dispatcher's errorKind we persist (redeclared so the store
 * doesn't import the SW-heavy dispatcher). `tool_not_found` is never recorded. */
export type HealthErrorKind = 'rate_limited' | 'auth_required' | 'empty' | 'tab' | 'generic';

export interface RunOutcome {
  ts: number;
  ok: boolean;
  /** Present only when `!ok`. */
  kind?: HealthErrorKind;
}

/** One agent-authored experience note about an adapter's site (⑩). */
export interface AdapterNote {
  ts: number;
  text: string;
}

/** One rolling summary per tool id (`${site}/${name}`). */
export interface AdapterHealth {
  id: string;
  runs: number;
  lastRunTs: number;
  /** Last successful run — "last worked". */
  lastOkTs?: number;
  lastStatus: 'ok' | 'fail';
  lastErrorKind?: HealthErrorKind;
  lastError?: string;
  /** Consecutive DRIFT fails since the last ok — the heal trigger (P2). A
   * blocked/infra fail neither increments nor resets it. */
  consecutiveDriftFails: number;
  /** Rolling window of recent outcomes (oldest→newest), capped. */
  recent: RunOutcome[];
  /** Agent-authored experience notes (⑩): appended only on a SURPRISE (site
   * revamp / anti-bot change / a strategy that stopped working), surfaced back
   * when the adapter next fails. NOT normal-run telemetry (that's `recent`). */
  notes?: AdapterNote[];
}

export type HealthStatus = 'healthy' | 'degraded' | 'broken' | 'blocked' | 'unknown';

const DRIFT_KINDS = new Set<HealthErrorKind>(['empty', 'generic']);
const RECENT_CAP = 20;
/** Consecutive drift fails at/after which an adapter is "broken" (heal candidate). */
export const BROKEN_THRESHOLD = 3;

/** SW-set hook fired ONCE when an adapter crosses into "broken", so the UI can
 * proactively offer a heal (H1-P2c). Decoupled from chrome messaging. */
let brokenNotifier: ((id: string, lastError?: string) => void) | null = null;
export function setBrokenNotifier(fn: ((id: string, lastError?: string) => void) | null): void {
  brokenNotifier = fn;
}

/** A drift fail means the adapter (selector/endpoint) likely broke, vs a site-side
 * block (auth/rate) or our own infra hiccup (tab). */
export function isDriftKind(k: HealthErrorKind | undefined): boolean {
  return !!k && DRIFT_KINDS.has(k);
}

/** Convert an agent tool name `site__name` → the health-store id `site/name`
 * (health + note key). Null for generic / non-adapter tools. Pure. */
export function toHealthId(tool: string): string | null {
  const sep = tool.indexOf('__');
  if (sep < 0) return null;
  const site = tool.slice(0, sep);
  if (site === 'generic') return null;
  return `${site}/${tool.slice(sep + 2)}`;
}

/** Fold one outcome into a health record (pure — the caller persists the result).
 * `lastError` is the truncated message for display when `!o.ok`. */
export function applyOutcome(
  prev: AdapterHealth | undefined,
  o: RunOutcome,
  id: string,
  lastError?: string,
): AdapterHealth {
  const recent = [...(prev?.recent ?? []), o].slice(-RECENT_CAP);
  const prevConsec = prev?.consecutiveDriftFails ?? 0;
  const consecutiveDriftFails = o.ok ? 0 : isDriftKind(o.kind) ? prevConsec + 1 : prevConsec; // blocked/infra fail: leave the drift counter untouched
  return {
    id,
    runs: (prev?.runs ?? 0) + 1,
    lastRunTs: o.ts,
    lastOkTs: o.ok ? o.ts : prev?.lastOkTs,
    lastStatus: o.ok ? 'ok' : 'fail',
    lastErrorKind: o.ok ? undefined : o.kind,
    lastError: o.ok ? undefined : lastError,
    consecutiveDriftFails,
    recent,
    // Preserve agent notes (⑩) across outcome writes — this record is REBUILT on
    // every call, so without carrying `notes` forward, the next run after a note
    // was written would clobber it (F-35: ⑩ read-back never fired because a
    // routine success/failure between write and read wiped the note).
    notes: prev?.notes,
  };
}

/** Pure status from a health record. */
export function computeHealthStatus(h: AdapterHealth | undefined): HealthStatus {
  if (!h || h.runs === 0) return 'unknown';
  if (h.lastStatus === 'ok') return 'healthy'; // it just worked — a recovery resets concern
  if (!isDriftKind(h.lastErrorKind)) return 'blocked'; // auth / rate / tab — site-side, not drift
  if (h.consecutiveDriftFails >= BROKEN_THRESHOLD) return 'broken';
  return 'degraded';
}

const NOTES_CAP = 8;

/** Append an agent experience note, capped, skipping an exact repeat of the last
 * one (so re-hitting the same issue doesn't spam) (⑩). Pure; unit-tested. */
export function appendNote(
  prev: AdapterNote[] | undefined,
  text: string,
  ts: number,
): AdapterNote[] {
  const t = text.trim();
  const cur = prev ?? [];
  if (!t) return cur;
  if (cur.length && cur[cur.length - 1].text === t) return cur; // de-dupe consecutive
  return [...cur, { ts, text: t }].slice(-NOTES_CAP);
}

// ── IndexedDB (best-effort; no-ops without indexedDB) ───────────────────────

const DB_NAME = 'web-agent-health';
const STORE = 'adapter_health';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Record one run outcome for tool id `${site}/${name}`. Best-effort, atomic
 * read-modify-write in one transaction (IDB serializes same-store writes, so
 * concurrent runs of the same tool don't lose updates). */
export async function recordRun(
  id: string,
  ok: boolean,
  kind?: HealthErrorKind,
  error?: string,
): Promise<void> {
  try {
    const db = await openDb();
    let justBroke = false;
    let brokeError: string | undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const prev = getReq.result as AdapterHealth | undefined;
        const next = applyOutcome(prev, { ts: Date.now(), ok, kind }, id, error?.slice(0, 200));
        store.put(next);
        // Fire only on the EXACT transition into broken (not every later fail).
        if (next.consecutiveDriftFails === BROKEN_THRESHOLD) {
          justBroke = true;
          brokeError = next.lastError;
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    if (justBroke) brokenNotifier?.(id, brokeError);
  } catch (e) {
    warn('health', 'recordRun failed', e);
  }
}

/** Append an agent experience note to adapter id `${site}/${name}` (⑩).
 * Best-effort IDB read-modify-write; no-op without indexedDB. */
export async function recordAdapterNote(id: string, text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const prev = getReq.result as AdapterHealth | undefined;
        const base: AdapterHealth = prev ?? {
          id,
          runs: 0,
          lastRunTs: Date.now(),
          lastStatus: 'ok',
          consecutiveDriftFails: 0,
          recent: [],
        };
        store.put({ ...base, notes: appendNote(base.notes, text, Date.now()) });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    warn('health', 'recordAdapterNote failed', e);
  }
}

/** Read one adapter's health record (⑩: surface notes when it next fails).
 * Best-effort; undefined if unknown / no indexedDB. */
export async function getAdapterHealth(id: string): Promise<AdapterHealth | undefined> {
  try {
    const db = await openDb();
    const rec = await new Promise<AdapterHealth | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as AdapterHealth | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rec;
  } catch (e) {
    warn('health', 'getAdapterHealth failed', e);
    return undefined;
  }
}

/** All health records (for the Adapters page). */
export async function getAllHealth(): Promise<AdapterHealth[]> {
  try {
    const db = await openDb();
    const all = await new Promise<AdapterHealth[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as AdapterHealth[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all;
  } catch (e) {
    warn('health', 'getAllHealth failed', e);
    return [];
  }
}

/** Forget health for one adapter (e.g. after a successful heal / re-install). */
export async function clearHealth(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    warn('health', 'clearHealth failed', e);
  }
}
