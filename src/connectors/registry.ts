/**
 * Chatbot connector registry — the seam for "which chatbot web page do we
 * hijack as the LLM" in connector mode.
 *
 * Today only DeepSeek has a working connector (content scripts in
 * connectors/deepseek/). ChatGPT / Gemini are declared here as placeholders so
 * the settings UI can offer them and so adding a real connector later is a
 * localized change (drop content scripts + flip `implemented`).
 */

import type { ChatbotId } from '../config/llm-config';

export interface ChatbotMeta {
  id: ChatbotId;
  label: string;
  /** Landing URL opened when the user has no chatbot tab yet. */
  landingUrl: string;
  /** URL match patterns the connector's content scripts run on. */
  matches: string[];
  /** Whether a working connector is implemented. */
  implemented: boolean;
}

export const CHATBOT_REGISTRY: Record<ChatbotId, ChatbotMeta> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    landingUrl: 'https://chat.deepseek.com/',
    matches: ['https://chat.deepseek.com/*'],
    implemented: true,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    landingUrl: 'https://chatgpt.com/',
    matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    implemented: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    landingUrl: 'https://gemini.google.com/app',
    matches: ['https://gemini.google.com/*'],
    implemented: false,
  },
};

export function getChatbot(id: ChatbotId): ChatbotMeta {
  return CHATBOT_REGISTRY[id] ?? CHATBOT_REGISTRY.deepseek;
}
