/**
 * Session state — one per active conversation in the SidePanel. Persisted to
 * IndexedDB so the SidePanel can recover after SW restarts.
 *
 * Pre-history: when the connector mode existed, this also tracked the bound
 * chatbot tab id, conversation UUID, pause-on-tab-loss machinery, and a
 * pendingPrompt for resume. All of that is gone — api-engine sessions only
 * need turn history + an OpenAI message array.
 */

import type { PageRef, ParsedCommand } from '../messages';
import type { ApiMessage } from './api-types';
import type { PlanState } from './plan';
import { log } from '@base/runtime/log';
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
  /** Compact bubble text when `text` is a long generated prompt ("Summarize this page" etc.). */
  displayText?: string;
  /** Pages this turn refers to — rendered as quote cards under the bubble. */
  pageRefs?: PageRef[];
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

export type SessionStatus = 'idle' | 'running' | 'aborted' | 'error';

export interface SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  iterations: number;
  history: Turn[];
  /** API engine's running OpenAI message array, persisted across follow-up
   * turns so native tool_calls / tool results stay paired 1:1. */
  apiMessages?: ApiMessage[];
  /** Living todo/plan the agent maintains (Phase 1). Persisted so it survives
   * SW restarts and shows in the history view. */
  plan?: PlanState;
  /** Auto mode for this run: skip per-write confirmation (set from the
   * USER_MESSAGE's autoApprove; per-conversation). */
  autoApprove?: boolean;
  /** Explore v2 binding: present once this chat session has driven an explore
   * run, so a follow-up in explore mode rebinds to the SAME trace (append)
   * instead of starting fresh — resume after abort / error / SW death. See
   * docs/llm-explore.md § Explore v2. */
  explore?: {
    traceId: string;
    site?: string;
    /** Slice boundary for the next synthesis. */
    cursor: number;
    /** Adapters synthesized so far (for stable ids on resume). */
    adapterCount: number;
  };
  /** Explore v2: synthesized adapters this chat produced (source + verify),
   * persisted so the export bundle (and a reloaded panel) recover them even
   * after the in-panel card state is gone. `verify.preview` is dropped to keep
   * the session row lean. */
  exploreAdapters?: import('../messages').ExploreAdapter[];
  /** H1-P2 heal run: the drifted adapter this explore turn re-derives. Drives
   * the auto-persist origin after a passing synthesis (overwrite the ORIGINAL
   * id instead of creating a new explore-origin copy). One-turn semantics:
   * reset from every USER_MESSAGE (mirrors the panel's healTarget state). */
  healTarget?: import('../messages').UserMessageReq['healTarget'];
  /** Set when this session is the record of a scheduled-task run (H3): the
   * workflow ran headless in the SW and its turns landed here, so the session
   * history lists it with a ⏰ scheduled-task badge and the user can open /
   * continue it. */
  schedule?: { id: string; label: string };
}

export function makeSession(id: string): SessionState {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    iterations: 0,
    history: [],
  };
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
