/**
 * Cross-session long-term memory (optional) — a flat store of short user
 * facts/preferences the agent chooses to remember (via the `remember` tool),
 * recalled into the system prompt at the start of every run. This is the
 * long-term tier of the memory model (short-term = message window, working =
 * plan + compaction ledger). Its own IndexedDB database so it never collides
 * with session-store's schema/version. docs/agent-harness.md §10.10.
 *
 * The IDB CRUD isn't unit-tested (no IndexedDB in the node test env, same as
 * session-store); the pure `renderMemoryBlock` is — see tests/memory.test.ts.
 */
import { warn } from '../runtime/log';

export interface MemoryFact {
  id: string;
  text: string;
  createdAt: number;
}

const DB_NAME = 'webchat-memory';
const STORE = 'facts';

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

export async function addMemory(text: string): Promise<MemoryFact | null> {
  const t = text.trim();
  if (!t) return null;
  const fact: MemoryFact = {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: t,
    createdAt: Date.now(),
  };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(fact);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return fact;
  } catch (e) {
    warn('memory', 'addMemory failed', e);
    return null;
  }
}

export async function listMemories(): Promise<MemoryFact[]> {
  try {
    const db = await openDb();
    const facts = await new Promise<MemoryFact[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as MemoryFact[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return facts.sort((a, b) => a.createdAt - b.createdAt);
  } catch (e) {
    warn('memory', 'listMemories failed', e);
    return [];
  }
}

export async function deleteMemory(id: string): Promise<void> {
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
    warn('memory', 'deleteMemory failed', e);
  }
}

/** Pure: render long-term memories into a system-prompt block (capped). Empty
 * when there are none. */
export function renderMemoryBlock(facts: MemoryFact[], cap = 20): string {
  if (!facts.length) return '';
  const lines = facts.slice(0, cap).map((f) => `- ${f.text}`);
  return (
    '\n\n## 关于用户(长期记忆)\n以下是你之前记住的关于该用户的事实/偏好,作答时可参考:\n' +
    lines.join('\n')
  );
}
