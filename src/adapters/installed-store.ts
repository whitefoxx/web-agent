/**
 * IndexedDB-backed persistent store for runtime-INSTALLED adapters.
 *
 * Mirrors the pattern of agent/session-store.ts (same DB, separate object
 * store). Survives browser restarts so installed adapters come back without a
 * re-install or a rebuild — the whole point of the hot-plug feature.
 *
 * Best-effort: in a node test environment (no indexedDB) every op no-ops /
 * returns empty, exactly like session-store, so the install manager can be
 * unit-tested without a fake-IDB.
 *
 * Schema lives in the shared "webchat-agent" DB, bumped to v2 to add the
 * "installed_adapters" store alongside the existing "sessions" store.
 */

import { warn } from '../runtime/log';

/** A persisted installed adapter. `defs` are the captured cli() definitions
 * (one source file can register several commands); `kind` is the dominant
 * classification used for UI + execution routing. */
export interface InstalledAdapter {
  /** Primary key. For single-command sources this is `${site}/${name}`; for a
   * multi-command source it's the source's first command's id (stable). */
  id: string;
  /** Display title (site/name of the first def, or a user-given label). */
  title: string;
  /** Verbatim source the user installed (kept for re-eval / Phase B func). */
  source: string;
  /** Captured, serializable adapter definitions (no closures). */
  defs: CapturedDef[];
  /** Whether ANY def is a func adapter (Phase B). pipeline-only sources are
   * fully runnable today. */
  kind: 'pipeline' | 'func' | 'mixed' | 'unknown';
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  origin: { type: 'marketplace' | 'manual' | 'explore'; url?: string };
  /** For explore-synthesized adapters: the verify ("试跑") outcome so the UI can
   * distinguish untested / passed / failed. Undefined for non-explore installs. */
  verifyStatus?: 'untested' | 'passed' | 'failed';
  /** Short note from the last verify (rows returned, or the error). */
  verifyNote?: string;
  verifiedAt?: number;
}

/** Serializable adapter definition shape (matches sandbox CapturedAdapter,
 * re-declared here to avoid importing sandbox code into the SW bundle). */
export interface CapturedDef {
  site: string;
  name: string;
  access?: 'read' | 'write';
  description?: string;
  domain?: string;
  strategy?: string;
  args?: unknown[];
  columns?: string[];
  pipeline?: unknown[];
  navigateBefore?: unknown;
  siteSession?: string;
  kind: 'pipeline' | 'func' | 'unknown';
  hasFunc: boolean;
}

const DB_NAME = 'webchat-agent';
const DB_VERSION = 2; // bumped from 1 (sessions-only) to add installed_adapters
const STORE_INSTALLED = 'installed_adapters';
const STORE_SESSIONS = 'sessions'; // must be preserved across the upgrade

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
        // Create whichever stores are missing. onupgradeneeded fires for a
        // fresh DB (no stores) AND for the v1→v2 bump (sessions exists,
        // installed_adapters doesn't) — handle both without touching existing
        // data.
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          const s = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
          s.createIndex('by_updated', 'updatedAt');
          s.createIndex('by_status', 'status');
        }
        if (!db.objectStoreNames.contains(STORE_INSTALLED)) {
          const s = db.createObjectStore(STORE_INSTALLED, { keyPath: 'id' });
          s.createIndex('by_updated', 'updatedAt');
          s.createIndex('by_enabled', 'enabled');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Step aside if another context bumps the version, so its upgrade isn't
        // blocked. (Both this and session-store open the shared DB at v2; the
        // missing handler here + the version skew was the "IDB open blocked".)
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

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE_INSTALLED, mode);
        const store = t.objectStore(STORE_INSTALLED);
        fn(store).then(
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

export async function putInstalled(a: InstalledAdapter): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx('readwrite', (store) => reqAsPromise(store.put(a)).then(() => undefined));
  } catch (e) {
    warn('installed-store', 'putInstalled failed', e);
  }
}

export async function getInstalled(id: string): Promise<InstalledAdapter | null> {
  if (!hasIndexedDb()) return null;
  try {
    return await tx('readonly', async (store) => {
      const v = await reqAsPromise(store.get(id));
      return (v as InstalledAdapter | undefined) ?? null;
    });
  } catch (e) {
    warn('installed-store', 'getInstalled failed', e);
    return null;
  }
}

export async function listInstalled(): Promise<InstalledAdapter[]> {
  if (!hasIndexedDb()) return [];
  try {
    return await tx('readonly', async (store) => {
      const all = await reqAsPromise(store.getAll());
      const rows = (all as InstalledAdapter[]) ?? [];
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      return rows;
    });
  } catch (e) {
    warn('installed-store', 'listInstalled failed', e);
    return [];
  }
}

export async function deleteInstalled(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx('readwrite', (store) => reqAsPromise(store.delete(id)).then(() => undefined));
  } catch (e) {
    warn('installed-store', 'deleteInstalled failed', e);
  }
}

export async function setInstalledEnabled(id: string, enabled: boolean): Promise<void> {
  if (!hasIndexedDb()) return;
  const row = await getInstalled(id);
  if (!row) return;
  row.enabled = enabled;
  row.updatedAt = Date.now();
  await putInstalled(row);
}

/** Record an explore adapter's verify ("试跑") outcome. */
export async function setInstalledVerify(
  id: string,
  status: 'untested' | 'passed' | 'failed',
  note?: string,
): Promise<void> {
  if (!hasIndexedDb()) return;
  const row = await getInstalled(id);
  if (!row) return;
  row.verifyStatus = status;
  row.verifyNote = note;
  row.verifiedAt = Date.now();
  row.updatedAt = Date.now();
  await putInstalled(row);
}
