/**
 * Session-scoped image registry — short stable tokens (`img_3`) for image refs
 * surfaced by tool results, so a TEXT-ONLY primary can reference a screenshot
 * it never received the bytes of (§10.25).
 *
 * Why: tool-result TEXT redacts base64 blobs (stripDataUrls — hundreds of KB of
 * base64 would drown the context), and the real bytes are only auto-attached
 * when the PRIMARY is multimodal (visionInline). With a separate vision slot,
 * the model used to see only the placeholder — and could only echo it back into
 * view_image ("data:image/png;base64,[image omitted]"), which the provider then
 * tried to DOWNLOAD (Aliyun "Download multimodal file timed out", §10.24).
 * Now the blob is replaced by `[img_N]`, and view_image resolves `img_N` back
 * to the registered ref.
 *
 * In-memory, per SW lifetime, capped per session. On resume the counter is
 * re-seeded from replayed history (seedImageRegistry) so a NEW image never
 * reuses an id that a historical [img_N] token still refers to — a lost ref
 * yields a clear "reference expired, take a new screenshot" error, never a
 * silently wrong image.
 */

const PER_SESSION_CAP = 24;

interface Registry {
  /** Insertion order of ids (for eviction + "most recent" listing). */
  order: string[];
  byId: Map<string, string>;
  /** Dedupe: same ref (e.g. re-collected on a later pass) keeps its id. */
  byRef: Map<string, string>;
  seq: number;
}

const registries = new Map<string, Registry>();

function registryFor(sessionId: string): Registry {
  let r = registries.get(sessionId);
  if (!r) {
    r = { order: [], byId: new Map(), byRef: new Map(), seq: 0 };
    registries.set(sessionId, r);
  }
  return r;
}

/** Seed the id counter for a RESUMED session so newly-minted ids never collide
 * with `img_N` tokens already baked into replayed history. The registry is
 * in-memory per SW lifetime, but the `[img_N]` tokens it minted are persisted
 * verbatim in `session.apiMessages`. After an SW teardown the registry is empty
 * (seq=0) while those tokens survive — without this, the next image would
 * re-mint `img_1` and `view_image("img_1")` would resolve to a DIFFERENT image
 * than the historical one (silent wrong image). Scanning history for the
 * high-water N and bumping `seq` to it means new images get N+1…, and any stale
 * historical token resolves to null (graceful "reference expired"). Idempotent; call at
 * session start BEFORE the first registerImage. */
export function seedImageRegistry(sessionId: string, texts: Iterable<string>): void {
  const r = registryFor(sessionId);
  let max = r.seq;
  for (const t of texts) {
    if (!t) continue;
    const re = /img_(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  r.seq = max;
}

/** Register an image ref (data URL or http URL); returns its stable `img_N`
 * token. Re-registering the same ref returns the same token. */
export function registerImage(sessionId: string, ref: string): string {
  const r = registryFor(sessionId);
  const existing = r.byRef.get(ref);
  if (existing) {
    // LRU touch: a re-referenced image shouldn't be evicted before newer one-offs
    // (was pure FIFO — a repeatedly-used screenshot could age out prematurely).
    const i = r.order.indexOf(existing);
    if (i >= 0 && i < r.order.length - 1) {
      r.order.splice(i, 1);
      r.order.push(existing);
    }
    return existing;
  }
  const id = `img_${++r.seq}`;
  r.order.push(id);
  r.byId.set(id, ref);
  r.byRef.set(ref, id);
  while (r.order.length > PER_SESSION_CAP) {
    const evict = r.order.shift()!;
    const evictRef = r.byId.get(evict);
    r.byId.delete(evict);
    if (evictRef !== undefined) r.byRef.delete(evictRef);
  }
  return id;
}

/** Resolve a model-provided token back to the registered ref. Tolerates the
 * bracketed form the result text shows (`[img_3]`) and stray whitespace.
 * Null when unknown / evicted / from a previous SW life. */
export function resolveImageRef(sessionId: string, token: string): string | null {
  const m = /^\[?\s*(img_\d+)\s*\]?$/.exec(token.trim());
  if (!m) return null;
  return registries.get(sessionId)?.byId.get(m[1]) ?? null;
}

/** Registered ids, oldest → newest (for "available image references" error hints). */
export function listImageIds(sessionId: string): string[] {
  return [...(registries.get(sessionId)?.order ?? [])];
}

/** Tests only. */
export function __resetImageRegistry(): void {
  registries.clear();
}
