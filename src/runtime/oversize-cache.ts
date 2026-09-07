/**
 * Oversize tool-result cache (docs/agent-harness.md §truncation): when a tool
 * result exceeds MAX_TOOL_RESULT_CHARS, the tail used to be cut and LOST — the
 * model couldn't recover it even when the task needed it, and the user was
 * never told. Now the FULL text is stashed here (SW memory, LRU + TTL) and the
 * truncation marker carries an id + offset so the model can page through the
 * rest with the generic `read_more` tool (divide-and-conquer: read a chunk,
 * extract, continue).
 *
 * Bounded on purpose: ~24 entries / 15 min — this is a within-task continuation
 * buffer, not storage. An SW restart drops it; read_more then answers "expired,
 * re-run the original tool".
 */

const MAX_ENTRIES = 24;
const TTL_MS = 15 * 60_000;

interface Entry {
  text: string;
  at: number;
}

const entries = new Map<string, Entry>(); // insertion order ≈ LRU (refreshed on read)

function prune(now: number): void {
  for (const [k, v] of entries) {
    if (now - v.at > TTL_MS) entries.delete(k);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Stash a full oversize text; returns the id for the truncation marker. */
export function stashOversize(text: string, now = Date.now()): string {
  const id = `ov_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  entries.set(id, { text, at: now });
  prune(now);
  return id;
}

export interface ChunkResult {
  ok: boolean;
  error?: string;
  id?: string;
  offset?: number;
  chunk?: string;
  /** Offset to pass next; absent when done. */
  next_offset?: number;
  remaining?: number;
  total_chars?: number;
  done?: boolean;
}

/** Read one chunk of a stashed result. Refreshes the entry's LRU position. */
export function readChunk(
  id: string,
  offset: number,
  maxChars: number,
  now = Date.now(),
): ChunkResult {
  const e = entries.get(id);
  if (!e || now - e.at > TTL_MS) {
    entries.delete(id);
    return {
      ok: false,
      error: 'This cached result has expired or does not exist (the cache is kept for about 15 minutes). Re-run the original tool call to get the data.',
    };
  }
  // LRU refresh: keep an actively-read entry alive across a long paging loop.
  e.at = now;
  entries.delete(id);
  entries.set(id, e);
  const total = e.text.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + maxChars);
  const done = end >= total;
  return {
    ok: true,
    id,
    offset: start,
    chunk: e.text.slice(start, end),
    ...(done ? {} : { next_offset: end }),
    remaining: total - end,
    total_chars: total,
    done,
  };
}

/** Test hook. */
export function resetOversizeCacheForTests(): void {
  entries.clear();
}
