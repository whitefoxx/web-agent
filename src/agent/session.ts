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
import { log, warn } from '../runtime/log';

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

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  chatbot: 'deepseek';
  chatbotTabId: number | null;
  status: 'idle' | 'running' | 'aborted' | 'error';
  iterations: number;
  history: Turn[];
}

const STORAGE_KEY_PREFIX = 'webchat:session:';
const SESSION_INDEX_KEY = 'webchat:sessionIds';

export function makeSession(id: string): SessionState {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chatbot: 'deepseek',
    chatbotTabId: null,
    status: 'idle',
    iterations: 0,
    history: [],
  };
}

export function appendTurn(s: SessionState, t: Turn): void {
  s.history.push(t);
  s.updatedAt = Date.now();
}

function safeStorageSession(): chrome.storage.StorageArea | null {
  try {
    return chrome?.storage?.session ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(s: SessionState): Promise<void> {
  const store = safeStorageSession();
  if (!store) return;
  try {
    await store.set({ [STORAGE_KEY_PREFIX + s.id]: s });
    const idx = await loadIndex();
    if (!idx.includes(s.id)) {
      idx.push(s.id);
      await store.set({ [SESSION_INDEX_KEY]: idx });
    }
  } catch (e) {
    warn('session', 'saveSession failed', e);
  }
}

export async function loadSession(id: string): Promise<SessionState | null> {
  const store = safeStorageSession();
  if (!store) return null;
  try {
    const r = await store.get(STORAGE_KEY_PREFIX + id);
    const s = r?.[STORAGE_KEY_PREFIX + id] as SessionState | undefined;
    return s ?? null;
  } catch (e) {
    warn('session', 'loadSession failed', e);
    return null;
  }
}

export async function loadIndex(): Promise<string[]> {
  const store = safeStorageSession();
  if (!store) return [];
  try {
    const r = await store.get(SESSION_INDEX_KEY);
    return (r?.[SESSION_INDEX_KEY] as string[]) ?? [];
  } catch {
    return [];
  }
}

export async function deleteSession(id: string): Promise<void> {
  const store = safeStorageSession();
  if (!store) return;
  try {
    await store.remove(STORAGE_KEY_PREFIX + id);
    const idx = (await loadIndex()).filter((x) => x !== id);
    await store.set({ [SESSION_INDEX_KEY]: idx });
  } catch (e) {
    warn('session', 'deleteSession failed', e);
  }
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
