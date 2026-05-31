/**
 * LLM backend configuration.
 *
 * WebChat Agent supports two LLM backends, chosen at runtime:
 *
 *   - `connector`: hijack a logged-in chatbot web page (DeepSeek today;
 *     ChatGPT / Gemini are placeholders). Zero API key — inference comes from
 *     the user's own chatbot session. Driven by the text `<agent-command>`
 *     protocol (see agent/orchestrator.ts).
 *
 *   - `api`: call an OpenAI-compatible `/chat/completions` endpoint with an API
 *     key and native function-calling (see agent/api-engine.ts). Works with any
 *     provider speaking the OpenAI contract (DeepSeek, OpenAI, GLM, Kimi,
 *     MiniMax, …).
 *
 * Persisted in chrome.storage.local under a single key.
 */

export type ChatbotId = 'deepseek' | 'chatgpt' | 'gemini';

export interface ConnectorConfig {
  mode: 'connector';
  chatbot: ChatbotId;
}

export interface ApiConfig {
  mode: 'api';
  /** Preset id (or 'custom'); purely informational, the call uses baseUrl. */
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type LlmConfig = ConnectorConfig | ApiConfig;

/* ───────── presets ───────── */

export interface ChatbotPreset {
  id: ChatbotId;
  label: string;
  /** Landing URL of the chatbot's chat page. */
  url: string;
  /** Whether a working connector is implemented for this chatbot. */
  implemented: boolean;
}

export const CHATBOTS: ChatbotPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com', implemented: true },
  { id: 'chatgpt', label: 'ChatGPT（未实现）', url: 'https://chatgpt.com', implemented: false },
  { id: 'gemini', label: 'Gemini（未实现）', url: 'https://gemini.google.com', implemented: false },
];

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

/** Default keeps the project's "zero API key, zero config" identity. */
export const DEFAULT_CONFIG: LlmConfig = { mode: 'connector', chatbot: 'deepseek' };

const DEFAULT_API_DRAFT: Omit<ApiConfig, 'mode'> = {
  provider: 'deepseek',
  baseUrl: PROVIDERS[0]?.baseUrl ?? '',
  apiKey: '',
  model: PROVIDERS[0]?.defaultModel ?? '',
};

const DEFAULT_CONNECTOR_DRAFT: Omit<ConnectorConfig, 'mode'> = { chatbot: 'deepseek' };

/**
 * Storage shape — always carries BOTH branches' last-known values, with `mode`
 * naming which one is currently active. This lets the settings form re-show
 * your saved API key even after you saved a connector config (the previous
 * shape was a discriminated union, so saving connector clobbered the API key
 * outright). Consumers that only need the active config keep using
 * `loadLlmConfig()` which projects this down to ConnectorConfig | ApiConfig.
 */
interface StoredLlmConfig {
  mode: 'connector' | 'api';
  connector: Omit<ConnectorConfig, 'mode'>;
  api: Omit<ApiConfig, 'mode'>;
}

/** Form-friendly view that exposes both branches' drafts to the settings UI. */
export interface LlmConfigForm {
  mode: 'connector' | 'api';
  connector: Omit<ConnectorConfig, 'mode'>;
  api: Omit<ApiConfig, 'mode'>;
}

const DEFAULT_STORED: StoredLlmConfig = {
  mode: 'connector',
  connector: DEFAULT_CONNECTOR_DRAFT,
  api: DEFAULT_API_DRAFT,
};

/** Loads the on-disk record, normalizing the legacy discriminated-union shape
 * (pre dual-branch storage) into the current `StoredLlmConfig` form. Returns
 * defaults on any error or missing key. */
async function loadStored(): Promise<StoredLlmConfig> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const raw = got[STORAGE_KEY] as unknown;
    if (!raw || typeof raw !== 'object') return DEFAULT_STORED;
    const obj = raw as Record<string, unknown>;
    // New shape: has top-level `connector` + `api` objects.
    if (obj.connector && obj.api && (obj.mode === 'connector' || obj.mode === 'api')) {
      return {
        mode: obj.mode,
        connector: {
          ...DEFAULT_CONNECTOR_DRAFT,
          ...(obj.connector as Partial<Omit<ConnectorConfig, 'mode'>>),
        },
        api: { ...DEFAULT_API_DRAFT, ...(obj.api as Partial<Omit<ApiConfig, 'mode'>>) },
      };
    }
    // Legacy shape: one branch persisted, the other lost. Adopt it as the
    // active branch and seed the other from defaults.
    if (obj.mode === 'connector' && typeof obj.chatbot === 'string') {
      return {
        mode: 'connector',
        connector: { chatbot: obj.chatbot as ChatbotId },
        api: DEFAULT_API_DRAFT,
      };
    }
    if (obj.mode === 'api') {
      return {
        mode: 'api',
        connector: DEFAULT_CONNECTOR_DRAFT,
        api: {
          provider: String(obj.provider ?? DEFAULT_API_DRAFT.provider),
          baseUrl: String(obj.baseUrl ?? DEFAULT_API_DRAFT.baseUrl),
          apiKey: String(obj.apiKey ?? ''),
          model: String(obj.model ?? DEFAULT_API_DRAFT.model),
        },
      };
    }
    return DEFAULT_STORED;
  } catch {
    return DEFAULT_STORED;
  }
}

/** What consumers (agent engines, status pill, dirty-check) see: the active
 * branch as a tagged-union. Same signature as before the dual-storage change. */
export async function loadLlmConfig(): Promise<LlmConfig> {
  const stored = await loadStored();
  return stored.mode === 'connector'
    ? { mode: 'connector', chatbot: stored.connector.chatbot }
    : { mode: 'api', ...stored.api };
}

/** Form-only loader: returns BOTH branches' last-known values so the settings
 * UI can re-show a saved API key even after a connector-mode save. */
export async function loadLlmConfigForm(): Promise<LlmConfigForm> {
  return loadStored();
}

/** Persist the active branch WITHOUT clobbering the other branch's draft on
 * disk. Callers pass the active-shape config (same signature as before) — we
 * merge with what's already stored so switching modes doesn't lose data. */
export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  const existing = await loadStored();
  const next: StoredLlmConfig = {
    mode: config.mode,
    connector: config.mode === 'connector' ? { chatbot: config.chatbot } : existing.connector,
    api:
      config.mode === 'api'
        ? {
            provider: config.provider,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
          }
        : existing.api,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

/** Sometimes the user is mid-edit (e.g. typed an API key, then flipped to
 * connector mode without clicking save) — they'd lose the typed value if we
 * didn't snapshot. Callers can flush the in-flight form draft here. Same
 * merge semantics as `saveLlmConfig` but the active branch stays unchanged. */
export async function persistLlmConfigDraft(draft: {
  connector?: Omit<ConnectorConfig, 'mode'>;
  api?: Omit<ApiConfig, 'mode'>;
}): Promise<void> {
  const existing = await loadStored();
  const next: StoredLlmConfig = {
    mode: existing.mode,
    connector: draft.connector ? { ...existing.connector, ...draft.connector } : existing.connector,
    api: draft.api ? { ...existing.api, ...draft.api } : existing.api,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
