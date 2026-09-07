/**
 * IndexedDB-backed store for explore traces.
 *
 * Deliberately a SEPARATE database from the shared "web-agent" DB
 * (sessions + installed_adapters). Traces are large (network bodies, DOM
 * snapshots) and independently disposable; isolating them keeps the hot path
 * DB small and lets the version evolve without coordinating with
 * session-store.ts / installed-store.ts.
 *
 * Best-effort: in node (no indexedDB) every op no-ops / returns empty, exactly
 * like installed-store.ts, so the recorder unit-tests without a fake-IDB.
 *
 * Layout:
 *   traces        keyPath 'traceId'          — TraceMeta, one per trace
 *   trace_events  keyPath ['traceId','seq']  — append-only TraceEvent rows,
 *                 index by_trace on 'traceId'
 */

import { warn } from '@base/runtime/log';
import type { TraceEvent, TraceMeta, SiteMemory, Finding } from './types';

const DB_NAME = 'web-agent-traces';
// v2 adds the site_memory store (Explore v2 atomic-reuse findings).
const DB_VERSION = 2;
const STORE_TRACES = 'traces';
const STORE_EVENTS = 'trace_events';
const STORE_SITE_MEMORY = 'site_memory';

/** Stored event row = the event plus its owning traceId (the array keyPath
 * requires both fields to live on the object). */
type StoredEvent = TraceEvent & { traceId: string };

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB != null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (!hasIndexedDb()) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_TRACES)) {
          const s = db.createObjectStore(STORE_TRACES, { keyPath: 'traceId' });
          s.createIndex('by_updated', 'updatedAt');
          s.createIndex('by_status', 'status');
        }
        if (!db.objectStoreNames.contains(STORE_EVENTS)) {
          const s = db.createObjectStore(STORE_EVENTS, { keyPath: ['traceId', 'seq'] });
          s.createIndex('by_trace', 'traceId');
        }
        // v2: per-site accumulated findings (atomic reuse across explore runs).
        if (!db.objectStoreNames.contains(STORE_SITE_MEMORY)) {
          db.createObjectStore(STORE_SITE_MEMORY, { keyPath: 'site' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
      req.onblocked = () => reject(new Error('IDB open blocked'));
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

function tx<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        fn(t).then(
          (result) => {
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error ?? new Error('IDB tx failed'));
            t.onabort = () => reject(t.error ?? new Error('IDB tx aborted'));
          },
          (err) => {
            try {
              t.abort();
            } catch {
              /* already aborting */
            }
            reject(err);
          },
        );
      }),
  );
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

/** Create (or overwrite) a trace's metadata row. */
export async function createTrace(meta: TraceMeta): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx(STORE_TRACES, 'readwrite', (t) =>
      reqAsPromise(t.objectStore(STORE_TRACES).put(meta)).then(() => undefined),
    );
  } catch (e) {
    warn('trace-store', 'createTrace failed', e);
  }
}

/** Update a trace's metadata (status, counts, updatedAt). */
export async function updateTraceMeta(meta: TraceMeta): Promise<void> {
  // Same as createTrace (put is upsert) — separate name for call-site clarity.
  return createTrace(meta);
}

/** Append events to a trace. Each event must carry its own `seq`. */
export async function appendEvents(traceId: string, events: TraceEvent[]): Promise<void> {
  if (!hasIndexedDb() || events.length === 0) return;
  try {
    await tx(STORE_EVENTS, 'readwrite', async (t) => {
      const store = t.objectStore(STORE_EVENTS);
      for (const ev of events) {
        const row: StoredEvent = { ...ev, traceId };
        store.put(row);
      }
      return undefined;
    });
  } catch (e) {
    warn('trace-store', 'appendEvents failed', e);
  }
}

export async function getTraceMeta(traceId: string): Promise<TraceMeta | null> {
  if (!hasIndexedDb()) return null;
  try {
    return await tx(STORE_TRACES, 'readonly', async (t) => {
      const v = await reqAsPromise(t.objectStore(STORE_TRACES).get(traceId));
      return (v as TraceMeta | undefined) ?? null;
    });
  } catch (e) {
    warn('trace-store', 'getTraceMeta failed', e);
    return null;
  }
}

export async function listTraces(): Promise<TraceMeta[]> {
  if (!hasIndexedDb()) return [];
  try {
    return await tx(STORE_TRACES, 'readonly', async (t) => {
      const all = await reqAsPromise(t.objectStore(STORE_TRACES).getAll());
      const rows = (all as TraceMeta[]) ?? [];
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows;
    });
  } catch (e) {
    warn('trace-store', 'listTraces failed', e);
    return [];
  }
}

/** All events for a trace, in seq order. */
export async function getTraceEvents(traceId: string): Promise<TraceEvent[]> {
  if (!hasIndexedDb()) return [];
  try {
    return await tx(STORE_EVENTS, 'readonly', async (t) => {
      const idx = t.objectStore(STORE_EVENTS).index('by_trace');
      const all = await reqAsPromise(idx.getAll(IDBKeyRange.only(traceId)));
      const rows = (all as StoredEvent[]) ?? [];
      // getAll over the index returns rows ordered by primary key
      // [traceId, seq] → already seq-ascending, but sort defensively.
      rows.sort((a, b) => a.seq - b.seq);
      return rows as TraceEvent[];
    });
  } catch (e) {
    warn('trace-store', 'getTraceEvents failed', e);
    return [];
  }
}

/** Convenience: metadata + events together. Returns null if the trace is
 * unknown (or IDB is unavailable). */
export async function getTrace(
  traceId: string,
): Promise<(TraceMeta & { events: TraceEvent[] }) | null> {
  const meta = await getTraceMeta(traceId);
  if (!meta) return null;
  const events = await getTraceEvents(traceId);
  return { ...meta, events };
}

/** Per-site accumulated findings, or null if none yet. */
export async function getSiteMemory(site: string): Promise<SiteMemory | null> {
  if (!hasIndexedDb() || !site) return null;
  try {
    return await tx(STORE_SITE_MEMORY, 'readonly', async (t) => {
      const v = await reqAsPromise(t.objectStore(STORE_SITE_MEMORY).get(site));
      return (v as SiteMemory | undefined) ?? null;
    });
  } catch (e) {
    warn('trace-store', 'getSiteMemory failed', e);
    return null;
  }
}

/** Append a finding to a site's memory (dedup by identical text), best-effort.
 * Returns the updated memory (or null if IDB is unavailable). */
export async function addFinding(site: string, finding: Finding): Promise<SiteMemory | null> {
  if (!hasIndexedDb() || !site) return null;
  try {
    return await tx(STORE_SITE_MEMORY, 'readwrite', async (t) => {
      const store = t.objectStore(STORE_SITE_MEMORY);
      const existing = ((await reqAsPromise(store.get(site))) as SiteMemory | undefined) ?? {
        site,
        findings: [],
        updatedAt: 0,
      };
      const norm = finding.text.trim().toLowerCase();
      if (!existing.findings.some((f) => f.text.trim().toLowerCase() === norm)) {
        existing.findings.push(finding);
      }
      existing.updatedAt = finding.ts;
      await reqAsPromise(store.put(existing));
      return existing;
    });
  } catch (e) {
    warn('trace-store', 'addFinding failed', e);
    return null;
  }
}

/** Delete a trace and all its events. */
export async function deleteTrace(traceId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx([STORE_TRACES, STORE_EVENTS], 'readwrite', async (t) => {
      t.objectStore(STORE_TRACES).delete(traceId);
      // [traceId] (1-elem array) sorts before [traceId, <any number>]; [traceId, []]
      // sorts after them (array > number in IDB key ordering) — covers all rows.
      const range = IDBKeyRange.bound([traceId], [traceId, []]);
      const cursorReq = t.objectStore(STORE_EVENTS).openCursor(range);
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
      });
      return undefined;
    });
  } catch (e) {
    warn('trace-store', 'deleteTrace failed', e);
  }
}
