/**
 * Cross-session long-term memory (optional) — a SINGLE free-form markdown
 * document (ChatGPT-style "memory summary"), recalled into the system prompt at
 * the start of every run when enabled. This is the long-term tier of the memory
 * model (short-term = message window, working = plan + compaction ledger).
 *
 * History: this used to be a flat list of short `MemoryFact` rows in its own
 * IndexedDB. 2026-07-17 it was reworked to one blob the user (or the agent, via
 * `update_memory`) edits directly — no auto-extraction, no per-item ids. Backed
 * by chrome.storage.local (a single small value; no IDB schema to version).
 *
 * The pure renderers (`renderMemoryBlock` / `renderMemoryExport`) are unit-tested
 * (tests/memory.test.ts); the storage I/O is not (no chrome in the node env).
 */
import { warn } from '@base/runtime/log';

export interface MemoryState {
  /** Master switch — mirrors ChatGPT's "Enable memory". When false the block is
   * never injected and `update_memory` is inert. */
  enabled: boolean;
  /** The whole memory as one markdown document. */
  content: string;
  /** Last write (blob or toggle), ms epoch. 0 = never written. */
  updatedAt: number;
}

const KEY = 'memory';

export const DEFAULT_MEMORY: MemoryState = { enabled: true, content: '', updatedAt: 0 };

function hasStorage(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local;
  } catch {
    return false;
  }
}

/** Read the current memory state (defaults when unset / unavailable). */
export async function getMemory(): Promise<MemoryState> {
  if (!hasStorage()) return { ...DEFAULT_MEMORY };
  try {
    const got = await chrome.storage.local.get(KEY);
    const v = got[KEY];
    if (v && typeof v === 'object') {
      return {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
        content: typeof v.content === 'string' ? v.content : '',
        updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
      };
    }
  } catch (e) {
    warn('memory', 'getMemory failed', e);
  }
  return { ...DEFAULT_MEMORY };
}

async function write(next: MemoryState): Promise<MemoryState> {
  if (hasStorage()) {
    try {
      await chrome.storage.local.set({ [KEY]: next });
    } catch (e) {
      warn('memory', 'write failed', e);
    }
  }
  return next;
}

/** Replace the whole memory document (trimmed of trailing whitespace only —
 * internal newlines are preserved). Keeps the current enabled flag. */
export async function setMemoryContent(content: string): Promise<MemoryState> {
  const cur = await getMemory();
  return write({ ...cur, content: content.replace(/\s+$/, ''), updatedAt: Date.now() });
}

/** Flip the master switch. Content is preserved. */
export async function setMemoryEnabled(enabled: boolean): Promise<MemoryState> {
  const cur = await getMemory();
  return write({ ...cur, enabled, updatedAt: Date.now() });
}

/** Append a single line/fact to the document (used by the bridge `remember`
 * tool, and as a cheap fallback). No-op on empty input. */
export async function appendMemory(line: string): Promise<MemoryState> {
  const t = line.trim();
  const cur = await getMemory();
  if (!t) return cur;
  const body = cur.content.trim();
  const next = body ? `${body}\n- ${t}` : `- ${t}`;
  return write({ ...cur, content: next, updatedAt: Date.now() });
}

/** Pure: render the memory into a downloadable markdown document. */
export function renderMemoryExport(state: MemoryState): string {
  const stamp = state.updatedAt ? new Date(state.updatedAt).toISOString().slice(0, 10) : '';
  const head = stamp ? `# My Memory (updated ${stamp})\n` : '# My Memory\n';
  return `${head}\n${state.content.trim()}\n`;
}

/** Pure: render the memory into a system-prompt block. Empty when disabled or
 * blank. `cap` bounds the injected length (chars) so a runaway blob can't crowd
 * out the rest of the prompt. */
export function renderMemoryBlock(state: MemoryState, cap = 4000): string {
  if (!state.enabled) return '';
  const body = state.content.trim();
  if (!body) return '';
  const clipped = body.length > cap ? `${body.slice(0, cap)}\n…(truncated)` : body;
  return (
    '\n\n## About the user (long-term memory)\nThe following are long-term facts / preferences the user maintains about themselves; you may draw on them when answering' +
    ' (ignore anything irrelevant to the current task):\n' +
    clipped
  );
}
