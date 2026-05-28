/**
 * Interface every chatbot connector must implement. Today the implementation
 * is hard-wired to DeepSeek but the interface keeps things ready for
 * ChatGPT / Gemini etc. Each connector runs as an isolated-world content
 * script on the chatbot's site.
 */

import type { ChatbotResponseEvt, ConnectorReadyEvt, InjectAckEvt } from './messages';

export interface ChatbotConnector {
  /** Stable identifier used in messages (e.g. "deepseek"). */
  readonly name: 'deepseek';

  /** Wait until the page is ready (textarea present, logged in). */
  waitForReady(timeoutMs: number): Promise<boolean>;

  /** Announce readiness to the service worker. */
  notifyReady(): Promise<void>;

  /** Click the "New chat" launcher so the next injection lands in a fresh
   * conversation. Resolves to false if the button could not be found. */
  startFreshChat(): Promise<boolean>;

  /** Inject `text` into the chat input and trigger submission. */
  inject(text: string): Promise<void>;

  /** Begin monitoring the assistant's response. The promise resolves once
   * the response is stable (no further mutations for a quiet window). */
  awaitResponse(
    iterationId: string,
    baselineKey: number,
  ): Promise<{
    rawText: string;
    cleanedText: string;
    reasoningText?: string;
    commands: import('./messages').ParsedCommand[];
  }>;

  /** Snapshot of the last `[data-virtual-list-item-key]` value (so we can
   * tell user's just-sent message from prior turns). */
  baselineMessageKey(): number;
}

export type ConnectorIncoming = InjectAckEvt | ConnectorReadyEvt | ChatbotResponseEvt;
