/**
 * Session state — one per active conversation in the SidePanel. Persisted to
 * chrome.storage.session so the SidePanel can recover after SW restarts.
 *
 * The "conversation" tracked here is the user-facing one in the SidePanel,
 * not the underlying DeepSeek tab conversation. Each turn the user sends
 * triggers a fresh DeepSeek conversation (click "New chat" first), keeps
 * one DeepSeek conversation per WebChat-Agent turn round, so DeepSeek's
 * context isn't polluted across separate user requests.
 */

import type { ParsedCommand } from '../connectors/messages';
import type { ApiMessage } from './api-types';
import { log } from '../runtime/log';
import {
  deleteSessionFromDb,
  getSession,
  listSessions as listSessionsFromDb,
  putSession,
  type ListOptions,
} from './session-store';

export interface UserTurn {
  role: 'user';
  text: string;
  ts: number;
}

export interface AssistantTurn {
  role: 'assistant';
  cleanedText: string;
  reasoningText?: string;
  commands: ParsedCommand[];
  iteration: number;
  ts: number;
}

export interface ToolTraceTurn {
  role: 'tool_trace';
  trace: {
    id: string;
    action: string;
    tool?: string;
    args?: Record<string, unknown>;
    status: 'started' | 'completed' | 'failed';
    result?: unknown;
    error?: string;
    durationMs?: number;
  };
  ts: number;
}

export type Turn = UserTurn | AssistantTurn | ToolTraceTurn;

export type SessionStatus = 'idle' | 'running' | 'paused' | 'aborted' | 'error';

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  chatbot: 'deepseek';
  chatbotTabId: number | null;
  /** DeepSeek conversation UUID (from /a/chat/s/<uuid>). Null until first
   * response is received. */
  conversationId: string | null;
  /** Full deepseek URL captured at last successful response — used as the
   * landing URL when Resume opens a fresh tab. */
  conversationUrl: string | null;
  /** Prompt that was queued for the next iteration but hasn't been
   * successfully delivered + answered yet. Resume re-injects this. Cleared
   * once a response arrives. */
  pendingPrompt: string | null;
  /** Reason last pause happened, if status='paused'. */
  pauseReason: 'tab_closed' | 'tab_navigated_away' | 'conv_mismatch' | 'tab_not_ready' | null;
  /** How many user-initiated turns have happened since we last re-injected
   * the full system prompt. After ~N follow-up turns the chatbot tends to
   * drift back to its default behaviour (using its own knowledge / built-in
   * search instead of agent-command tools), so the orchestrator periodically
   * refreshes the prompt to anchor it. Reset to 0 on every full-prompt
   * injection; only incremented on continuation turns that just got a
   * lightweight reminder. */
  turnsSinceFullPrompt: number;
  status: SessionStatus;
  iterations: number;
  history: Turn[];
  /** API-mode (api-engine) running OpenAI message array, persisted across
   * follow-up turns so native tool_calls / tool results stay paired 1:1.
   * Unused in connector mode. */
  apiMessages?: ApiMessage[];
}

/* Persistent storage is delegated to session-store.ts (IndexedDB). The
 * helpers below preserve the previous chrome.storage.session API so
 * orchestrator / service-worker call sites don't change. */

export function makeSession(id: string): SessionState {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chatbot: 'deepseek',
    chatbotTabId: null,
    conversationId: null,
    conversationUrl: null,
    pendingPrompt: null,
    pauseReason: null,
    turnsSinceFullPrompt: 0,
    status: 'idle',
    iterations: 0,
    history: [],
  };
}

/** Parse the DeepSeek conversation UUID out of a tab URL.
 * Example: https://chat.deepseek.com/a/chat/s/b939e551-c798-4fc9-baef-29ac5282237b
 * → "b939e551-c798-4fc9-baef-29ac5282237b". Returns null for the
 * homepage (`/`) or any other URL. */
export function parseConversationUrl(
  url: string | undefined | null,
): { conversationId: string; conversationUrl: string } | null {
  if (!url) return null;
  const m = url.match(/https:\/\/chat\.deepseek\.com\/a\/chat\/s\/([0-9a-fA-F-]{16,})/);
  if (!m) return null;
  return { conversationId: m[1], conversationUrl: url };
}

/** Strip the conversation suffix back to the DeepSeek base URL — handy for
 * recognising an "idle" tab that can be claimed by a new session. */
export function isDeepseekIdleUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  // Treat the homepage and any not-yet-started chat as idle. We DON'T treat
  // /a/chat/s/<uuid> as idle (that tab is already running a conversation).
  if (!url.startsWith('https://chat.deepseek.com')) return false;
  return !/\/a\/chat\/s\//.test(url);
}

export function appendTurn(s: SessionState, t: Turn): void {
  s.history.push(t);
  s.updatedAt = Date.now();
}

export async function saveSession(s: SessionState): Promise<void> {
  s.updatedAt = Date.now();
  await putSession(s);
}

export async function loadSession(id: string): Promise<SessionState | null> {
  return getSession(id);
}

export async function listSessions(opts: ListOptions = {}): Promise<SessionState[]> {
  return listSessionsFromDb(opts);
}

export async function deleteSession(id: string): Promise<void> {
  await deleteSessionFromDb(id);
}

export function makeSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newIterationId(s: SessionState): string {
  return `${s.id}_i${s.iterations}`;
}

export function logSessionEvent(s: SessionState, msg: string, data?: unknown): void {
  log('session', `[${s.id}] ${msg}`, data);
}
