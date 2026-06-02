/**
 * LLM backend configuration — multi-profile + capability slots.
 *
 * A **profile** is one credential set (provider + baseUrl + apiKey + model) with
 * a label and id. **Capability slots** then assign a profile to each job:
 *   - `primary`  — the orchestrator the agent loop runs on (required)
 *   - `vision`   — image understanding (optional)
 *   - `image`    — image generation (optional)
 * One profile may fill several slots (e.g. a multimodal model = primary+vision).
 * Each slot points to AT MOST one profile → no ambiguity about "which model".
 * The main model decides via tool calls when to use a specialist; the engine
 * routes the call to that slot's profile API. See docs/architecture.md §8.6.
 *
 * Calls an OpenAI-compatible `/chat/completions` (+ `/images/generations`)
 * endpoint. Works with any provider speaking the OpenAI contract.
 *
 * Pre-history: earlier shapes were a single LlmConfig, then `{ activeId,
 * profiles }`, plus two removed chat-tab connector shapes. `normalize` migrates
 * all of them — `activeId` becomes `slots.primary`, a profile's old `vision:true`
 * flag becomes the `vision` slot. Persisted in chrome.storage.local.
 */

/** A job a model can be assigned to. Extensible (audio/video later). */
export type Capability = 'primary' | 'vision' | 'image';

export interface CapabilityMeta {
  id: Capability;
  label: string;
  required: boolean;
  hint: string;
}

/** Ordered for the settings UI. `primary` first + required. */
export const CAPABILITIES: CapabilityMeta[] = [
  {
    id: 'primary',
    label: '主模型(推理 / 编排)',
    required: true,
    hint: 'agent 在它上面跑,负责推理和调用工具。必填。',
  },
  {
    id: 'vision',
    label: '视觉理解',
    required: false,
    hint: '分析图片内容。可与主模型选同一个(多模态主模型),也可指一个专门的视觉模型。',
  },
  {
    id: 'image',
    label: '图像生成',
    required: false,
    hint: '根据文本生成图片。主模型需要时调用,结果(图片 URL)回灌给主模型。',
  },
];

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
  profiles: LlmProfile[];
  /** capability → profileId. `primary` is the orchestrator. Missing = unassigned. */
  slots: Partial<Record<Capability, string>>;
}

/** Slots resolved to actual profiles (null when unassigned / dangling). */
export interface ResolvedSlots {
  primary: LlmProfile | null;
  vision: LlmProfile | null;
  image: LlmProfile | null;
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

/** Read the **primary** (orchestrator) profile's config — what the main agent
 * loop consumes. Returns DEFAULT_CONFIG when there's no primary, so the
 * existing `!cfg.apiKey` readiness check upstream keeps working. */
export async function loadLlmConfig(): Promise<LlmConfig> {
  const { primary } = await resolveSlots();
  if (!primary) return { ...DEFAULT_CONFIG };
  return {
    provider: primary.provider,
    baseUrl: primary.baseUrl,
    apiKey: primary.apiKey,
    model: primary.model,
  };
}

/** Resolve every capability slot to its assigned profile (null if unassigned or
 * the assigned id no longer exists). One storage read. */
export async function resolveSlots(): Promise<ResolvedSlots> {
  const store = await loadProfiles();
  const get = (c: Capability): LlmProfile | null =>
    store.profiles.find((p) => p.id === store.slots[c]) ?? null;
  return { primary: get('primary'), vision: get('vision'), image: get('image') };
}

/** Read the full multi-profile store (for the UI manager). */
export async function loadProfiles(): Promise<LlmProfileStore> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return normalize(got[STORAGE_KEY] as unknown);
  } catch {
    return { profiles: [], slots: {} };
  }
}

export async function saveProfiles(store: LlmProfileStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

/** Insert or update a profile by id. With `asPrimary: true` (or when no primary
 * is set yet — the first profile created) assigns it to the primary slot. */
export async function upsertProfile(
  profile: LlmProfile,
  opts: { asPrimary?: boolean } = {},
): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  const idx = store.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) store.profiles[idx] = profile;
  else store.profiles.push(profile);
  if (opts.asPrimary || !store.slots.primary) store.slots.primary = profile.id;
  await saveProfiles(store);
  return store;
}

/** Remove a profile + clear it from every slot it filled. If it was the
 * primary, the first remaining profile takes over (so the agent stays runnable). */
export async function deleteProfile(id: string): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  for (const cap of Object.keys(store.slots) as Capability[]) {
    if (store.slots[cap] === id) delete store.slots[cap];
  }
  if (!store.slots.primary) {
    // Promote a RUNNABLE profile (has key + baseUrl) if possible, so deleting
    // the primary doesn't silently leave the store unrunnable; fall back to
    // first-by-order only if none are fully configured.
    const next = store.profiles.find((p) => p.apiKey && p.baseUrl) ?? store.profiles[0];
    if (next) store.slots.primary = next.id;
  }
  await saveProfiles(store);
  return store;
}

/** Assign a profile to a capability slot, or clear it (`profileId = null`).
 * Refuses to clear `primary` while any profile exists — an empty primary means
 * the agent can't run, so we never let a stray null orphan the orchestrator
 * (the UI also hides the clear option for the required slot, belt-and-suspenders). */
export async function setSlot(cap: Capability, profileId: string | null): Promise<LlmProfileStore> {
  const store = await loadProfiles();
  if (profileId && store.profiles.some((p) => p.id === profileId)) {
    store.slots[cap] = profileId;
  } else {
    if (cap === 'primary' && store.profiles.length > 0) return store; // never orphan primary
    delete store.slots[cap];
  }
  await saveProfiles(store);
  return store;
}

/** Backward-compat alias: "make this profile the primary (orchestrator)". */
export async function setActiveProfile(id: string): Promise<LlmProfileStore> {
  return setSlot('primary', id);
}

/** Backward-compat: "update the primary profile's fields with this config".
 * If no profile exists yet, creates one and makes it primary. */
export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const store = await loadProfiles();
  const primary = store.profiles.find((p) => p.id === store.slots.primary);
  if (primary) {
    primary.provider = config.provider;
    primary.baseUrl = config.baseUrl;
    primary.apiKey = config.apiKey;
    primary.model = config.model;
    primary.label = autoLabel(config);
    await saveProfiles(store);
    return;
  }
  const id = newProfileId();
  store.profiles.push({ id, label: autoLabel(config), ...config });
  store.slots.primary = id;
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
  if (!raw || typeof raw !== 'object') return { profiles: [], slots: {} };
  const obj = raw as Record<string, unknown>;

  // Current / multi-profile shape (with `profiles`).
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
      // NB: the old per-profile `vision:true` flag is DROPPED, not migrated to
      // the vision slot. It meant "this model is multimodal" (a capability), NOT
      // "use this model for vision" (an assignment). Auto-assigning it surprised
      // users who wanted to split vision onto a dedicated model — the vision slot
      // is assigned explicitly in 模型分工.
    }

    // Slots: prefer an explicit `slots` map (new shape), clamped to existing
    // profiles; otherwise migrate `activeId` → primary. vision/image are only
    // ever set explicitly by the user.
    const slots: Partial<Record<Capability, string>> = {};
    const rawSlots = (obj.slots ?? {}) as Record<string, unknown>;
    for (const cap of ['primary', 'vision', 'image'] as Capability[]) {
      const want = rawSlots[cap];
      if (typeof want === 'string' && profiles.some((p) => p.id === want)) slots[cap] = want;
    }
    if (!slots.primary) {
      const activeId = typeof obj.activeId === 'string' ? obj.activeId : '';
      const fallback = profiles.some((p) => p.id === activeId) ? activeId : profiles[0]?.id;
      if (fallback) slots.primary = fallback;
    }
    return { profiles, slots };
  }

  // Legacy single-config shapes — recover the LlmConfig, then wrap.
  const single = normalizeSingle(obj);
  // Totally-empty recovery (no apiKey AND no baseUrl) = "never configured" →
  // empty store, so the empty-list UI shows instead of a phantom keyless profile.
  if (!single.apiKey && !single.baseUrl) return { profiles: [], slots: {} };
  const id = newProfileId();
  return {
    profiles: [{ id, label: autoLabel(single), ...single }],
    slots: { primary: id },
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
