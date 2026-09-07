/**
 * Notes — user-curated markdown notes, managed on the My Notes page and
 * via the intercepted `notes` tool. UNLIKE long-term memory (memory-store),
 * notes are NEVER injected into the system prompt: the agent reads/writes them
 * only when the user explicitly asks. Pure text/markdown — image LINKS render,
 * but there are no uploads. Its own IndexedDB database so it never collides
 * with memory-store / session-store schemas.
 *
 * The IDB CRUD isn't unit-tested (no IndexedDB in the node test env, same as
 * memory-store); the pure helpers (deriveNoteTitle / matchNotes / noteExcerpt /
 * renderNotesExport) and execNotesAction's arg validation are — see
 * tests/notes-store.test.ts.
 */
import { warn } from '@base/runtime/log';

export interface Note {
  id: string;
  title: string;
  /** Markdown body (image links allowed; no uploads). */
  content: string;
  /** Who created it: the user (page UI), the agent (`notes` tool), or the
   * "Save as note" button on an assistant reply. */
  source: 'user' | 'agent' | 'reply';
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'web-notes';
const STORE = 'notes';

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

export async function addNote(input: {
  title?: string;
  content: string;
  source?: Note['source'];
}): Promise<Note | null> {
  const content = String(input.content ?? '').trim();
  if (!content) return null;
  const now = Date.now();
  const note: Note = {
    id: `n_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: (input.title ?? '').trim() || deriveNoteTitle(content),
    content,
    source: input.source ?? 'user',
    createdAt: now,
    updatedAt: now,
  };
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(note);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return note;
  } catch (e) {
    warn('notes', 'addNote failed', e);
    return null;
  }
}

/** All notes, newest-updated first (a notebook reads latest-first). */
export async function listNotes(): Promise<Note[]> {
  try {
    const db = await openDb();
    const notes = await new Promise<Note[]>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Note[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return notes.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    warn('notes', 'listNotes failed', e);
    return [];
  }
}

export async function getNote(id: string): Promise<Note | null> {
  try {
    const db = await openDb();
    const note = await new Promise<Note | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as Note | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return note;
  } catch (e) {
    warn('notes', 'getNote failed', e);
    return null;
  }
}

/** Patch title and/or content (bumps updatedAt; keeps id + createdAt + source).
 * No-op when the id is unknown or the patch leaves the content empty. */
export async function updateNote(
  id: string,
  patch: { title?: string; content?: string },
): Promise<Note | null> {
  try {
    const db = await openDb();
    const note = await new Promise<Note | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const cur = getReq.result as Note | undefined;
        if (!cur) {
          resolve(null);
          return;
        }
        const content = patch.content !== undefined ? patch.content.trim() : cur.content;
        const title = patch.title !== undefined ? patch.title.trim() : cur.title;
        if (!content) {
          resolve(null);
          return;
        }
        const next: Note = {
          ...cur,
          title: title || deriveNoteTitle(content),
          content,
          updatedAt: Date.now(),
        };
        store.put(next);
        tx.oncomplete = () => resolve(next);
      };
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return note;
  } catch (e) {
    warn('notes', 'updateNote failed', e);
    return null;
  }
}

export async function deleteNote(id: string): Promise<void> {
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
    warn('notes', 'deleteNote failed', e);
  }
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/** Strip markdown decoration from one line so it reads as plain text. */
function stripMdLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
    .replace(/^#{1,6}\s+/, '') // heading marks
    .replace(/^>\s+/, '') // blockquote
    .replace(/^[-*+]\s+/, '') // list bullet
    .replace(/^\d+\.\s+/, '') // ordered bullet
    .replace(/(\*\*|__|\*|_|~~|`)/g, '') // emphasis / code marks
    .trim();
}

/** Title for an untitled note: the first non-empty line, de-markdowned and
 * capped. Falls back to "Untitled note". */
export function deriveNoteTitle(content: string, cap = 60): string {
  for (const raw of String(content ?? '').split('\n')) {
    const line = stripMdLine(raw);
    if (line) return line.length > cap ? `${line.slice(0, cap)}…` : line;
  }
  return 'Untitled note';
}

/** Plain-text excerpt of a markdown body (search results / collapsed cards). */
export function noteExcerpt(content: string, cap = 160): string {
  const text = String(content ?? '')
    .split('\n')
    .map(stripMdLine)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** Case-insensitive title+content substring match. Empty query → all notes. */
export function matchNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter(
    (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q),
  );
}

function fmtDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Render all notes into one markdown document for export/download. */
export function renderNotesExport(notes: Note[]): string {
  const head = `# My Notes (${notes.length})\n`;
  const body = notes
    .map((n) =>
      [
        `## ${n.title}`,
        '',
        `> Created ${fmtDay(n.createdAt)} · Updated ${fmtDay(n.updatedAt)} · Source ${n.source}`,
        '',
        n.content,
      ].join('\n'),
    )
    .join('\n\n---\n\n');
  return `${head}\n${body}\n`;
}

// ── the agent-facing CRUD action (shared by api-engine interception + bridge) ─

/** Actions that mutate notes — the bridge gates these on "allow external writes". */
export const NOTES_WRITE_ACTIONS: ReadonlySet<string> = new Set(['create', 'update', 'delete']);

const NOTE_LIST_CAP = 100;

function compactRow(n: Note): { id: string; title: string; updatedAt: number; excerpt: string } {
  return { id: n.id, title: n.title, updatedAt: n.updatedAt, excerpt: noteExcerpt(n.content, 120) };
}

/** Execute one `notes` tool call (create/list/search/get/update/delete).
 * Validates args BEFORE touching IndexedDB so bad calls fail fast (and so the
 * validation paths are unit-testable in node). list/search return compact rows
 * (id/title/excerpt) to keep token cost down; `get` returns the full content. */
export async function execNotesAction(
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const action = typeof args.action === 'string' ? args.action : '';
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const title = typeof args.title === 'string' ? args.title : undefined;
  const content = typeof args.content === 'string' ? args.content : undefined;
  const query = typeof args.query === 'string' ? args.query : '';

  switch (action) {
    case 'create': {
      if (!content?.trim()) return { ok: false, error: 'create requires non-empty content (markdown)' };
      const saved = await addNote({ title, content, source: 'agent' });
      return saved
        ? { ok: true, result: { id: saved.id, title: saved.title } }
        : { ok: false, error: 'Failed to save note' };
    }
    case 'list': {
      const notes = await listNotes();
      return { ok: true, result: notes.slice(0, NOTE_LIST_CAP).map(compactRow) };
    }
    case 'search': {
      if (!query.trim()) return { ok: false, error: 'search requires a query' };
      const notes = matchNotes(await listNotes(), query);
      return { ok: true, result: notes.slice(0, NOTE_LIST_CAP).map(compactRow) };
    }
    case 'get': {
      if (!id) return { ok: false, error: 'get requires an id (from list/search)' };
      const note = await getNote(id);
      return note ? { ok: true, result: note } : { ok: false, error: `No note ${id}` };
    }
    case 'update': {
      if (!id) return { ok: false, error: 'update requires an id (from list/search)' };
      if (title === undefined && content === undefined)
        return { ok: false, error: 'update requires at least one of title or content' };
      const next = await updateNote(id, { title, content });
      return next
        ? { ok: true, result: { id: next.id, title: next.title } }
        : { ok: false, error: `Update failed (no note ${id}, or content is empty)` };
    }
    case 'delete': {
      if (!id) return { ok: false, error: 'delete requires an id (from list/search)' };
      await deleteNote(id);
      return { ok: true, result: { deleted: id } };
    }
    default:
      return {
        ok: false,
        error: `Unknown action "${action}"; available: create / list / search / get / update / delete`,
      };
  }
}
