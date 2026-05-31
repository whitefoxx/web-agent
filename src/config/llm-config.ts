/**
 * LLM backend configuration.
 *
 * Calls an OpenAI-compatible `/chat/completions` endpoint with an API key and
 * native function-calling (see agent/api-engine.ts). Works with any provider
 * speaking the OpenAI contract — DeepSeek / OpenAI / GLM / Kimi / MiniMax / …
 *
 * Pre-history: there used to be a second `connector` mode that hijacked a
 * logged-in chatbot tab (DeepSeek) for inference and required no API key.
 * Removed because juggling both modes (write paths in the SW, status banners
 * in the UI, paused-session recovery) was not pulling its weight. The storage
 * layer used to dual-branch (api + connector drafts) and the loader/saver
 * still tolerate the legacy connector-only stored shape — it migrates to
 * api-defaults on first read. Persisted in chrome.storage.local under a
 * single key.
 */

export interface LlmConfig {
  /** Preset id (or 'custom'); informational, the call uses baseUrl. */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
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

export async function loadLlmConfig(): Promise<LlmConfig> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const raw = got[STORAGE_KEY] as unknown;
    return normalize(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Accepts both the current shape and two legacy shapes:
 *   1. Dual-branch transitional shape: `{ mode, connector, api }` — adopt `api`.
 *   2. Original discriminated union: `{ mode: 'api', provider, baseUrl, apiKey, model }`
 *      or `{ mode: 'connector', chatbot }` — the connector branch is dropped,
 *      defaults filled in.
 *   3. Already-current shape: `{ provider, baseUrl, apiKey, model }` — pass through. */
function normalize(raw: unknown): LlmConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  const obj = raw as Record<string, unknown>;
  // Dual-branch transitional shape (`api` is the source of truth even if the
  // active mode was 'connector' — we discard the connector pick).
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
  // Legacy api-only shape.
  if (obj.mode === 'api') {
    return {
      provider: String(obj.provider ?? DEFAULT_CONFIG.provider),
      baseUrl: String(obj.baseUrl ?? DEFAULT_CONFIG.baseUrl),
      apiKey: String(obj.apiKey ?? ''),
      model: String(obj.model ?? DEFAULT_CONFIG.model),
    };
  }
  // Current shape (no `mode` tag).
  if (typeof obj.provider === 'string' && typeof obj.baseUrl === 'string') {
    return {
      provider: obj.provider,
      baseUrl: obj.baseUrl,
      apiKey: String(obj.apiKey ?? ''),
      model: String(obj.model ?? ''),
    };
  }
  // Legacy connector-only or anything else: defaults.
  return { ...DEFAULT_CONFIG };
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
