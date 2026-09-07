/**
 * Secret vault — user-supplied sensitive values (API keys, tokens) that adapters
 * and tools need at call time but the **LLM must never see**.
 *
 * The whole point is *late binding*: the value lives in `chrome.storage.local`
 * (extension-private; the SW can read it, the visited page cannot — page
 * `localStorage`/`indexedDB` belong to the SITE's origin and its JS could read
 * them, so they're the wrong place), and it's spliced into a call **in the SW**,
 * after the model has already produced the tool call. Three binding paths, none
 * of which put the value into the model's context:
 *
 *   1. **env injection** (the common case — weread-official, notebooklm, v2ex):
 *      a `browser:false`/func adapter reads `process.env.NAME`. The SW scans the
 *      adapter source for `process.env.NAME`, looks each name up here, and pushes
 *      the matches into the adapter's `process.env` over the INIT port message
 *      into the isolated USER_SCRIPT world (run-in-page `installProcessPolyfill`).
 *      The model just calls `weread-official__search {query}` — no key in sight.
 *   2. **placeholder substitution** (any tool, any arg): the model (or a workflow
 *      step, or the user) writes `{{secret:NAME}}` as an arg value; the SW swaps
 *      in the real value at the dispatch chokepoint before the tool runs.
 *   3. **redaction** (defence in depth): every tool RESULT/ERROR is deep-scrubbed
 *      of known secret values → `«NAME»` before it becomes a `tool` message, so an
 *      adapter that echoes the key (e.g. "invalid key wrk-…") can't leak it either.
 *
 * Setting/editing a value is a **UI action only** — never accepted over the
 * bridge (mirrors the LLM-key boundary in bridge-client.ts). Listing returns
 * names + metadata, never values.
 *
 * The pure helpers (referencedEnvNames / resolveEnvForSource / scopeAllows /
 * substitutePlaceholders / redactSecrets) take a SecretMap and are unit-tested
 * in node; only load/save/delete touch chrome.storage.
 */

/** chrome.storage.local key holding the whole map. One blob keeps the read a
 * single get() on the hot path (every func-adapter run resolves env). */
export const SECRETS_STORAGE_KEY = 'web:secrets';

export interface SecretEntry {
  /** The sensitive value. NEVER returned to any LLM-reachable surface. */
  value: string;
  /** Optional site allow-list (base-site names, e.g. `weread-official`, or a
   * trailing-`*` glob like `weread*`). Empty/undefined → any adapter that
   * references this name is allowed (the reference itself is the boundary). */
  scope?: string[];
  /** Non-sensitive label shown in the UI (e.g. "微信读书 Agent key"). */
  note?: string;
  /** ms epoch of last write; informational (sortable in the UI). */
  updatedAt: number;
}

export type SecretMap = Record<string, SecretEntry>;

/** Name + metadata WITHOUT the value — the only shape that may cross into an
 * LLM-reachable surface (the settings list, the bridge `list_secret_names`). */
export interface SecretInfo {
  name: string;
  scope?: string[];
  note?: string;
  updatedAt: number;
  /** Always true (we only list names that exist) — lets a caller render "set". */
  hasValue: true;
}

/* ───────── pure helpers (no chrome.* — unit-tested) ───────── */

/** A valid secret name: uppercase-ish env identifier. We don't enforce case but
 * a name must be a JS identifier so it can sit on `process.env.NAME`. */
export function isValidSecretName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** Env var names an adapter source references via `process.env`. Covers the two
 * forms adapters actually use:
 *   - `process.env.NAME`            (weread-official getApiKey, the common one)
 *   - `process.env['NAME']` / ["…"] (bracket form)
 * Destructuring (`const { NAME } = process.env`) is intentionally NOT matched —
 * it would force us to inject the WHOLE vault for any adapter that destructures
 * `process.env`, defeating least-privilege. No shipped adapter uses it. */
export function referencedEnvNames(source: string): string[] {
  const names = new Set<string>();
  const dot = /process\.env\.([A-Za-z_$][\w$]*)/g;
  const bracket = /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g;
  for (let m = dot.exec(source); m; m = dot.exec(source)) names.add(m[1]);
  for (let m = bracket.exec(source); m; m = bracket.exec(source)) names.add(m[1]);
  return [...names];
}

/** Does this secret's scope allow `site`? No scope → yes (reference is the
 * boundary). Otherwise match the base site exactly or via a trailing-`*` glob. */
export function scopeAllows(entry: SecretEntry, site: string): boolean {
  if (!entry.scope || entry.scope.length === 0) return true;
  return entry.scope.some((rule) => {
    if (rule === site) return true;
    if (rule.endsWith('*')) return site.startsWith(rule.slice(0, -1));
    return false;
  });
}

/**
 * Build the `process.env` object to inject for a func adapter run: every secret
 * the source references AND whose scope allows the site. Least privilege — an
 * adapter only ever receives the names it literally reads.
 */
export function resolveEnvForSource(
  source: string,
  site: string,
  secrets: SecretMap,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of referencedEnvNames(source)) {
    const entry = secrets[name];
    if (entry && scopeAllows(entry, site)) env[name] = entry.value;
  }
  return env;
}

const PLACEHOLDER = /\{\{\s*secret:([A-Za-z_$][\w$]*)\s*\}\}/g;

/**
 * Deep-walk `args`, replacing any `{{secret:NAME}}` token in a string with the
 * vault value (whole-string OR embedded, e.g. `Bearer {{secret:X}}`). An unknown
 * NAME is left verbatim — better a visibly-broken call than a silent empty
 * credential. Returns the new args + the set of names actually substituted (for
 * logging / "you referenced an unset secret" hints — names only, not values).
 */
export function substitutePlaceholders(
  args: unknown,
  secrets: SecretMap,
): { value: unknown; used: string[]; missing: string[] } {
  const used = new Set<string>();
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes('{{')) return v;
      return v.replace(PLACEHOLDER, (whole, name: string) => {
        const entry = secrets[name];
        if (!entry) {
          missing.add(name);
          return whole;
        }
        used.add(name);
        return entry.value;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(args), used: [...used], missing: [...missing] };
}

/** Min length a value must have to be redaction-eligible — guards against a
 * 1–2 char "secret" turning every result into `«NAME»` soup. Real keys/tokens
 * are long; this only skips pathological tiny values. */
const REDACT_MIN_LEN = 6;

/**
 * Deep-walk any value and replace every occurrence of a known secret value with
 * `«NAME»`. Longest values first so an overlapping value can't be partially
 * masked. This is the net that keeps a key out of the model's context even if an
 * adapter is buggy/hostile and echoes it. NOTE: only literal occurrences are
 * caught — a base64/url-encoded echo would slip through (documented limitation).
 */
export function redactSecrets(value: unknown, secrets: SecretMap): unknown {
  const pairs = Object.entries(secrets)
    .map(([name, e]) => ({ name, value: e.value }))
    .filter((p) => typeof p.value === 'string' && p.value.length >= REDACT_MIN_LEN)
    .sort((a, b) => b.value.length - a.value.length);
  if (pairs.length === 0) return value;
  const scrub = (s: string): string => {
    let out = s;
    for (const p of pairs) {
      if (out.includes(p.value)) out = out.split(p.value).join(`«${p.name}»`);
    }
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

/** Strip values → the only shape safe to expose to an LLM-reachable surface. */
export function toSecretInfos(secrets: SecretMap): SecretInfo[] {
  return Object.entries(secrets)
    .map(([name, e]) => ({
      name,
      scope: e.scope,
      note: e.note,
      updatedAt: e.updatedAt,
      hasValue: true as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ───────── chrome.storage.local I/O (the only impure part) ───────── */

function storageArea(): chrome.storage.StorageArea | null {
  const c = (globalThis as { chrome?: { storage?: { local?: chrome.storage.StorageArea } } })
    .chrome;
  return c?.storage?.local ?? null;
}

/** Load the whole vault. Empty map if storage is unavailable (node tests) or
 * unset. Tolerant of a corrupt blob — a bad value can't brick adapter dispatch. */
export async function loadSecrets(): Promise<SecretMap> {
  const area = storageArea();
  if (!area) return {};
  try {
    const got = (await area.get(SECRETS_STORAGE_KEY)) as Record<string, unknown>;
    const raw = got?.[SECRETS_STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return {};
    const out: SecretMap = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as Partial<SecretEntry>;
      if (e && typeof e.value === 'string') {
        out[name] = {
          value: e.value,
          scope: Array.isArray(e.scope) ? e.scope.map(String) : undefined,
          note: typeof e.note === 'string' ? e.note : undefined,
          updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Create/replace one secret. `value` is required and non-empty. */
export async function saveSecret(
  name: string,
  fields: { value: string; scope?: string[]; note?: string },
): Promise<void> {
  if (!isValidSecretName(name)) throw new Error(`invalid secret name: ${name}`);
  if (!fields.value) throw new Error('secret value cannot be empty');
  const area = storageArea();
  if (!area) throw new Error('chrome.storage.local unavailable');
  const map = await loadSecrets();
  map[name] = {
    value: fields.value,
    scope: fields.scope && fields.scope.length ? fields.scope : undefined,
    note: fields.note || undefined,
    updatedAt: Date.now(),
  };
  await area.set({ [SECRETS_STORAGE_KEY]: map });
  invalidateSecretsCache();
}

/** Update only the non-value metadata (scope/note) of an existing secret,
 * leaving the value untouched — so the UI can edit scope without re-entering the
 * key. No-op if the name doesn't exist. */
export async function updateSecretMeta(
  name: string,
  fields: { scope?: string[]; note?: string },
): Promise<void> {
  const area = storageArea();
  if (!area) throw new Error('chrome.storage.local unavailable');
  const map = await loadSecrets();
  const cur = map[name];
  if (!cur) return;
  map[name] = {
    ...cur,
    scope: fields.scope && fields.scope.length ? fields.scope : undefined,
    note: fields.note ?? cur.note,
    updatedAt: Date.now(),
  };
  await area.set({ [SECRETS_STORAGE_KEY]: map });
  invalidateSecretsCache();
}

export async function deleteSecret(name: string): Promise<void> {
  const area = storageArea();
  if (!area) throw new Error('chrome.storage.local unavailable');
  const map = await loadSecrets();
  if (!(name in map)) return;
  delete map[name];
  await area.set({ [SECRETS_STORAGE_KEY]: map });
  invalidateSecretsCache();
}

/** Rename a secret (the name IS the storage key). Carries the existing **value**
 * over — so the UI can rename without ever re-entering or seeing the key — and
 * applies the given scope/note (the edit form's current values) in the same
 * write. Throws if `newName` is invalid, `oldName` is missing, or `newName`
 * already exists (we never silently clobber another secret). */
export async function renameSecret(
  oldName: string,
  newName: string,
  fields: { scope?: string[]; note?: string },
): Promise<void> {
  if (!isValidSecretName(newName)) throw new Error(`invalid secret name: ${newName}`);
  const area = storageArea();
  if (!area) throw new Error('chrome.storage.local unavailable');
  const map = await loadSecrets();
  const cur = map[oldName];
  if (!cur) throw new Error(`secret not found: ${oldName}`);
  if (newName !== oldName && map[newName]) throw new Error(`a credential named ${newName} already exists`);
  delete map[oldName];
  map[newName] = {
    value: cur.value, // carried over — never re-entered
    scope: fields.scope && fields.scope.length ? fields.scope : undefined,
    note: fields.note || undefined,
    updatedAt: Date.now(),
  };
  await area.set({ [SECRETS_STORAGE_KEY]: map });
  invalidateSecretsCache();
}

/** Names + metadata only (no values) — for the bridge / any LLM-reachable list. */
export async function listSecretInfos(): Promise<SecretInfo[]> {
  return toSecretInfos(await loadSecrets());
}

/* ───────── hot-path cache ───────── */

// `executeAdapter` resolves secrets on EVERY tool call (substitute args in,
// redact result out, env-inject func adapters). A chrome.storage.local.get per
// call is wasteful in a tight agent loop, so cache the map in the SW and drop it
// on any change — including a write from the sidepanel UI (a different JS
// context), which only chrome.storage.onChanged can tell us about.
let cache: SecretMap | null = null;
let listening = false;

function ensureInvalidation(): void {
  if (listening) return;
  const oc = (
    globalThis as {
      chrome?: { storage?: { onChanged?: { addListener?: (cb: unknown) => void } } };
    }
  ).chrome?.storage?.onChanged;
  if (oc?.addListener) {
    oc.addListener((changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes && SECRETS_STORAGE_KEY in changes) cache = null;
    });
    listening = true;
  }
}

/** Cached read for the hot path. Same shape as loadSecrets(); auto-invalidated
 * on any write (here or in the UI). */
export async function getSecretsCached(): Promise<SecretMap> {
  ensureInvalidation();
  if (cache) return cache;
  cache = await loadSecrets();
  return cache;
}

/** Drop the cache now (called by the mutators for same-context immediacy, since
 * onChanged may fire a tick later). */
export function invalidateSecretsCache(): void {
  cache = null;
}
