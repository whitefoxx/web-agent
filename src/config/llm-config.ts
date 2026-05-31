/**
 * LLM backend configuration — multi-profile storage.
 *
 * Each profile = a full set of credentials (provider + baseUrl + apiKey + model)
 * plus a user-given label and an id. The store remembers which profile is
 * `active`; api-engine reads only the active one via `loadLlmConfig`.
 *
 * Calls an OpenAI-compatible `/chat/completions` endpoint with native
 * function-calling (see agent/api-engine.ts). Works with any provider
 * speaking the OpenAI contract — DeepSeek / OpenAI / GLM / Kimi / MiniMax / …
 *
 * Pre-history: the store was a single LlmConfig under the same storage key.
 * Two earlier shapes (dual-branch `{ mode, connector, api }` and discriminated
 * union `{ mode: 'api' | 'connector', ... }`) trace back to a removed
 * chat-tab connector mode. `normalize` migrates all of them by wrapping
 * the recovered single-config into a one-entry profile list, so upgrading
 * users keep their saved key. Persisted in chrome.storage.local.
 */

export interface LlmConfig {
  /** Preset id (or 'custom'); informational, the call uses baseUrl. */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmProfile extends LlmConfig {
  /** Stable id, generated at create time (uuid). */
  id: string;
  /** User-visible name. Defaults to `${provider label} · ${model}`. */
  label: string;
}

export interface LlmProfileStore {
  /** Empty string when no profiles exist yet. */
  activeId: string;
  profiles: LlmProfile[];
}

/* ───────── presets ───────── */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

/** OpenAI-compatible API providers. `custom` lets the user type any base URL. */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
  },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
  },
  {
    id: 'kimi',
    label: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-Text-01',
  },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', defaultModel: '' },
];

/* ───────── storage ───────── */

const STORAGE_KEY = 'webchat_llm_config';

/** Empty defaults — the user MUST configure a key before the agent can run.
 * Pre-populated provider/baseUrl/model is a placeholder so the form shows
 * useful presets, not a "default working" config. */
export const DEFAULT_CONFIG: LlmConfig = {
  provider: 'deepseek',
  baseUrl: PROVIDERS[0]?.baseUrl ?? '',
  apiKey: '',
  model: PROVIDERS[0]?.defaultModel ?? '',
};

/** Read the **active** profile's config, in the legacy single-config shape
 * api-engine has always consumed. Returns DEFAULT_CONFIG when no profile is
 * active (or the store is empty), so the existing `!cfg.apiKey` readiness
 * check upstream keeps working. */
export async function loadLlmConfig(): Promise<LlmConfig> {
  const store = await loadProfiles();
  const active = store.profiles.find((p) => p.id === store.activeId);
  if (!active) return { ...DEFAULT_CONFIG };
  return {
    provider: active.provider,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
  };
}

/** Read the full multi-profile store (for the UI manager). */
export async function loadProfiles(): Promise<LlmProfileStore> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return normalize(got[STORAGE_KEY] as unknown);
  } catch {
    return { activeId: '', profiles: [] };
  }
}

export async function saveProfiles(store: LlmProfileStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/** Insert or update a profile by id. With `activate: true` (or when the
 * store has no current active), promotes the upserted profile to active. */
export async function upsertProfile(
  profile: LlmProfile,
  opts: { activate?: boolean } = {},
): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  const idx = store.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.push(profile);
  if (opts.activate || !store.activeId) store.activeId = profile.id;
  await saveProfiles(store);
  return store;
}

/** Remove a profile. If it was active, the first remaining profile (or '' if
 * none remain) becomes active. */
export async function deleteProfile(id: string): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.activeId === id) store.activeId = store.profiles[0]?.id ?? '';
  await saveProfiles(store);
  return store;
}

export async function setActiveProfile(id: string): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  if (store.profiles.some((p) => p.id === id)) {
    store.activeId = id;
    await saveProfiles(store);
  }
  return store;
}

/** Backward-compat: treat as "update the active profile's fields with this
 * config". If no profile exists yet, creates one and activates it. */
export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await loadProfiles();
  const active = store.profiles.find((p) => p.id === store.activeId);
  if (active) {
    active.provider = config.provider;
    active.baseUrl = config.baseUrl;
    active.apiKey = config.apiKey;
    active.model = config.model;
    active.label = autoLabel(config);
    await saveProfiles(store);
    return;
  }
  const id = newProfileId();
  store.profiles.push({ id, label: autoLabel(config), ...config });
  store.activeId = id;
  await saveProfiles(store);
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function newProfileId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Synthesize a human label from a config. Used as default when the user
 * doesn't override it. */
export function autoLabel(c: LlmConfig): string {
  const preset = providerById(c.provider);
  const provLabel = preset?.label ?? c.provider ?? 'custom';
  return c.model ? `${provLabel} · ${c.model}` : provLabel;
}

/* ───────── migration ───────── */

/** Accepts the current multi-profile shape AND four legacy shapes:
 *   1. Current: `{ activeId, profiles: [...] }` — pass through (clamp ids).
 *   2. Current-single-config: `{ provider, baseUrl, apiKey, model }` — wrap as
 *      one profile, active.
 *   3. Discriminated union: `{ mode: 'api', provider, baseUrl, apiKey, model }`
 *      or `{ mode: 'connector', chatbot }` — adopt api branch (or defaults
 *      for connector-only) and wrap.
 *   4. Dual-branch transitional: `{ mode, connector, api }` — adopt `api`
 *      and wrap.
 *
 * Empty/unrecognized → empty store. */
function normalize(raw: unknown): LlmProfileStore {
  if (!raw || typeof raw !== 'object') return { activeId: '', profiles: [] };
  const obj = raw as Record<string, unknown>;

  // Current shape.
  if (Array.isArray(obj.profiles)) {
    const profiles: LlmProfile[] = [];
    for (const p of obj.profiles) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      const cfg: LlmConfig = {
        provider: String(pp.provider ?? DEFAULT_CONFIG.provider),
        baseUrl: String(pp.baseUrl ?? DEFAULT_CONFIG.baseUrl),
        apiKey: String(pp.apiKey ?? ''),
        model: String(pp.model ?? DEFAULT_CONFIG.model),
      };
      const id = typeof pp.id === 'string' && pp.id ? pp.id : newProfileId();
      const label =
        typeof pp.label === 'string' && pp.label.trim() ? pp.label.trim() : autoLabel(cfg);
      profiles.push({ id, label, ...cfg });
    }
    let activeId = typeof obj.activeId === 'string' ? obj.activeId : '';
    if (!profiles.some((p) => p.id === activeId)) activeId = profiles[0]?.id ?? '';
    return { activeId, profiles };
  }

  // Legacy single-config shapes — recover the LlmConfig, then wrap.
  const single = normalizeSingle(obj);
  // Treat a totally-empty recovery (no apiKey AND no baseUrl beyond default
  // placeholder) as "user never configured anything" → empty store. That
  // way a connector-only legacy install (no api creds to recover) shows the
  // empty-list UI instead of a phantom "DeepSeek" profile with no key.
  if (!single.apiKey && !single.baseUrl) return { activeId: '', profiles: [] };
  const id = newProfileId();
  return {
    activeId: id,
    profiles: [{ id, label: autoLabel(single), ...single }],
  };
}

function normalizeSingle(obj: Record<string, unknown>): LlmConfig {
  // Dual-branch transitional (`api` is the source of truth).
  const apiSub = obj.api;
  if (apiSub && typeof apiSub === 'object') {
    const a = apiSub as Record<string, unknown>;
    return {
      provider: String(a.provider ?? DEFAULT_CONFIG.provider),
      baseUrl: String(a.baseUrl ?? DEFAULT_CONFIG.baseUrl),
      apiKey: String(a.apiKey ?? ''),
      model: String(a.model ?? DEFAULT_CONFIG.model),
    };
  }
  // Discriminated-union api shape.
  if (obj.mode === 'api') {
    return {
      provider: String(obj.provider ?? DEFAULT_CONFIG.provider),
      baseUrl: String(obj.baseUrl ?? DEFAULT_CONFIG.baseUrl),
      apiKey: String(obj.apiKey ?? ''),
      model: String(obj.model ?? DEFAULT_CONFIG.model),
    };
  }
  // Current-single shape (pre-multi-profile build).
  if (typeof obj.provider === 'string' && typeof obj.baseUrl === 'string') {
    return {
      provider: obj.provider,
      baseUrl: obj.baseUrl,
      apiKey: String(obj.apiKey ?? ''),
      model: String(obj.model ?? ''),
    };
  }
  // Legacy connector-only or anything else: empty (no api creds to recover).
  return { provider: '', baseUrl: '', apiKey: '', model: '' };
}
