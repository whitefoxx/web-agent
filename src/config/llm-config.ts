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
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-plus' },
  { id: 'kimi', label: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k2-0905-preview' },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-Text-01' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', defaultModel: '' },
];

/* ───────── storage ───────── */

const STORAGE_KEY = 'webchat_llm_config';

/** Default keeps the project's "zero API key, zero config" identity. */
export const DEFAULT_CONFIG: LlmConfig = { mode: 'connector', chatbot: 'deepseek' };

export async function loadLlmConfig(): Promise<LlmConfig> {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const c = got[STORAGE_KEY] as LlmConfig | undefined;
    if (!c || (c.mode !== 'connector' && c.mode !== 'api')) return DEFAULT_CONFIG;
    return c;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveLlmConfig(config: LlmConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
