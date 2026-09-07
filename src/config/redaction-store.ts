/**
 * Redaction patterns (page-agent borrow ⑦ — `transformPageContent`): user-defined
 * regexes scrubbed from every tool RESULT before it becomes a `tool` message, so
 * the model (the user's own LLM backend) never sees matched content — e.g. emails,
 * phone numbers, account ids the task doesn't need.
 *
 * Sits next to the secret vault ([[secret-store]]): the dispatcher's redaction
 * pass applies BOTH — known secret VALUES (redactSecrets) and these PATTERNS. The
 * pure helpers (compilePattern / applyRedactPatterns) take a pattern array and are
 * unit-tested in node; only load/save/delete touch chrome.storage.local.
 */

export const REDACT_STORAGE_KEY = 'web:redactPatterns';

export interface RedactPattern {
  /** Stable id (generated at create time). */
  id: string;
  /** Regex SOURCE (no slashes), e.g. `[\w.+-]+@[\w-]+\.[\w.-]+`. */
  pattern: string;
  /** Regex flags; `g` is forced on so all matches go, not just the first. */
  flags: string;
  /** Non-sensitive replacement label → matches become `«label»`. */
  label: string;
  enabled: boolean;
}

/* ───────── pure helpers (no chrome.* — unit-tested) ───────── */

/** Compile a pattern to a RegExp (global), or null if the source is invalid (a
 * bad regex must never break tool dispatch). */
export function compilePattern(p: RedactPattern): RegExp | null {
  if (!p.pattern) return null;
  const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
  try {
    return new RegExp(p.pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Deep-walk any value and replace every match of each ENABLED, valid pattern with
 * `«label»`. Returns the input unchanged when there are no usable patterns. Never
 * throws — a bad regex is skipped (compilePattern → null).
 */
export function applyRedactPatterns(value: unknown, patterns: RedactPattern[]): unknown {
  const compiled = patterns
    .filter((p) => p.enabled)
    .map((p) => ({ re: compilePattern(p), label: p.label }))
    .filter((c): c is { re: RegExp; label: string } => c.re !== null);
  if (compiled.length === 0) return value;
  const scrub = (s: string): string => {
    let out = s;
    for (const c of compiled) out = out.replace(c.re, `«${c.label}»`);
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** Validate a pattern's regex without saving — for the settings UI's live check. */
export function isValidRegex(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
    return true;
  } catch {
    return false;
  }
}

/* ───────── chrome.storage.local I/O + cache ───────── */

function area(): chrome.storage.StorageArea | null {
  const c = (globalThis as { chrome?: { storage?: { local?: chrome.storage.StorageArea } } })
    .chrome;
  return c?.storage?.local ?? null;
}

export async function loadRedactPatterns(): Promise<RedactPattern[]> {
  const a = area();
  if (!a) return [];
  try {
    const got = (await a.get(REDACT_STORAGE_KEY)) as Record<string, unknown>;
    const raw = got?.[REDACT_STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((v) => v as Partial<RedactPattern>)
      .filter((p) => typeof p.id === 'string' && typeof p.pattern === 'string')
      .map((p) => ({
        id: p.id as string,
        pattern: p.pattern as string,
        flags: typeof p.flags === 'string' ? p.flags : 'gi',
        label: typeof p.label === 'string' ? p.label : 'redacted',
        enabled: p.enabled !== false,
      }));
  } catch {
    return [];
  }
}

export async function saveRedactPattern(p: RedactPattern): Promise<void> {
  const a = area();
  if (!a) throw new Error('chrome.storage.local unavailable');
  const cur = await loadRedactPatterns();
  const i = cur.findIndex((x) => x.id === p.id);
  if (i >= 0) cur[i] = p;
  else cur.push(p);
  await a.set({ [REDACT_STORAGE_KEY]: cur });
  invalidateRedactCache();
}

export async function deleteRedactPattern(id: string): Promise<void> {
  const a = area();
  if (!a) throw new Error('chrome.storage.local unavailable');
  const cur = await loadRedactPatterns();
  await a.set({ [REDACT_STORAGE_KEY]: cur.filter((x) => x.id !== id) });
  invalidateRedactCache();
}

export function makeRedactId(): string {
  // No Math.random/Date.now in some sandboxes; chrome's crypto is fine in the SW
  // and sidepanel where this runs.
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.randomUUID ? c.randomUUID() : `r-${Date.now().toString(36)}`;
}

let cache: RedactPattern[] | null = null;
let listening = false;
function ensureInvalidation(): void {
  if (listening) return;
  const oc = (
    globalThis as { chrome?: { storage?: { onChanged?: { addListener?: (cb: unknown) => void } } } }
  ).chrome?.storage?.onChanged;
  if (oc?.addListener) {
    oc.addListener((changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && changes && REDACT_STORAGE_KEY in changes) cache = null;
    });
    listening = true;
  }
}
export async function getRedactPatternsCached(): Promise<RedactPattern[]> {
  ensureInvalidation();
  if (cache) return cache;
  cache = await loadRedactPatterns();
  return cache;
}
export function invalidateRedactCache(): void {
  cache = null;
}
