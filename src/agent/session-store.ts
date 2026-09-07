/**
 * IndexedDB-backed persistent store for SessionState.
 *
 * Why IndexedDB instead of chrome.storage.session:
 *   - `chrome.storage.session` is wiped on browser restart. Users want their
 *     past Web Agent conversations to survive a Chrome relaunch (and
 *     come back into the history drawer).
 *   - Sessions can grow large (transcripts + tool traces with truncated
 *     JSON payloads). IDB handles that gracefully; storage.local has a
 *     5–10 MB cap and per-key write amplification we don't want.
 *   - IDB indices let us pull "all sessions sorted by updatedAt" cheaply
 *     for the history list.
 *
 * Schema (v1):
 *   db: "web-agent"
 *   stores:
 *     "sessions" — keyPath "id"
 *       index "by_updated" on "updatedAt"
 *       index "by_status"  on "status"
 *
 * The store is best-effort: if IndexedDB isn't available (e.g., when the
 * unit tests load this module in a node environment), every operation
 * silently no-ops. That mirrors how the previous chrome.storage.session
 * shim behaved and keeps the api-engine's `saveSession` path test-safe.
 */

import type { SessionState, SessionStatus } from './session';
import { warn } from '@base/runtime/log';

const DB_NAME = 'web-agent';
// v2 adds the `installed_adapters` store (see adapters/installed-store.ts).
// BOTH openers of this shared DB must use the SAME version and create ALL
// stores on upgrade, or a v1 connection from one module blocks the other's v2
// open. They also register onversionchange (below) to step aside on a bump.
const DB_VERSION = 2;
const STORE_SESSIONS = 'sessions';
const STORE_INSTALLED = 'installed_adapters';

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
        // Create whichever stores are missing — handles a fresh DB and the
        // v1→v2 bump, and stays consistent with installed-store's upgrade so
        // whichever module opens first creates the full schema.
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          const store = db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
          store.createIndex('by_updated', 'updatedAt');
          store.createIndex('by_status', 'status');
        }
        if (!db.objectStoreNames.contains(STORE_INSTALLED)) {
          const store = db.createObjectStore(STORE_INSTALLED, { keyPath: 'id' });
          store.createIndex('by_updated', 'updatedAt');
          store.createIndex('by_enabled', 'enabled');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another context requests a version bump, close this connection so
        // its upgrade isn't blocked (the cause of "IDB open blocked").
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
      req.onblocked = () => reject(new Error('IDB open blocked'));
    }).catch((e) => {
      // Reset on failure so a later call retries (e.g. after permission
      // changes). Surface the rejection to the caller.
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
        const t = db.transaction(STORE_SESSIONS, mode);
        const store = t.objectStore(STORE_SESSIONS);
        fn(store).then(
          (result) => {
            t.oncomplete = () => resolve(result);
            t.onerror = () => reject(t.error ?? new Error('IDB tx failed'));
            t.onabort = () => reject(t.error ?? new Error('IDB tx aborted'));
          },
          (err) => {
            try {
              t.abort();
            } catch {}
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

export async function putSession(s: SessionState): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx('readwrite', (store) => reqAsPromise(store.put(s)).then(() => undefined));
  } catch (e) {
    warn('session-store', 'putSession failed', e);
  }
}

export async function getSession(id: string): Promise<SessionState | null> {
  if (!hasIndexedDb()) return null;
  try {
    return await tx('readonly', async (store) => {
      const v = await reqAsPromise(store.get(id));
      return (v as SessionState | undefined) ?? null;
    });
  } catch (e) {
    warn('session-store', 'getSession failed', e);
    return null;
  }
}

export async function deleteSessionFromDb(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx('readwrite', (store) => reqAsPromise(store.delete(id)).then(() => undefined));
  } catch (e) {
    warn('session-store', 'deleteSession failed', e);
  }
}

export interface ListOptions {
  /** Cap on rows returned. Default 100. */
  limit?: number;
  /** Filter by status. */
  status?: SessionStatus;
  /** Descending order on updatedAt (newest first). Default true. */
  newestFirst?: boolean;
}

export async function listSessions(opts: ListOptions = {}): Promise<SessionState[]> {
  if (!hasIndexedDb()) return [];
  const limit = opts.limit ?? 100;
  const newestFirst = opts.newestFirst !== false;
  try {
    return await tx('readonly', async (store) => {
      const index = store.index('by_updated');
      const direction: IDBCursorDirection = newestFirst ? 'prev' : 'next';
      return await new Promise<SessionState[]>((resolve, reject) => {
        const out: SessionState[] = [];
        const req = index.openCursor(null, direction);
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve(out);
          const s = cursor.value as SessionState;
          if (!opts.status || s.status === opts.status) {
            out.push(s);
            if (out.length >= limit) return resolve(out);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error('IDB cursor failed'));
      });
    });
  } catch (e) {
    warn('session-store', 'listSessions failed', e);
    return [];
  }
}

/** Useful for tests and "Clear all" UX. Not wired to any UI yet. */
export async function clearAllSessions(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    await tx('readwrite', (store) => reqAsPromise(store.clear()).then(() => undefined));
  } catch (e) {
    warn('session-store', 'clearAllSessions failed', e);
  }
}
