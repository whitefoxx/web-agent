/**
 * Chat-session CRUD for the SidePanel: list (summarised), fetch full state, and
 * delete (aborting any in-flight run first). Persisted state lives in IDB via
 * agent/session; this module just shapes it for the panel.
 */

import { log } from '@base/runtime/log';
import { deleteSession, listSessions, loadSession, type SessionState } from '../agent/session';
import { activeSessions } from './active-sessions';
import type {
  ListSessionsReq,
  ListSessionsResp,
  GetSessionReq,
  GetSessionResp,
  DeleteSessionReq,
  SessionSummary,
} from '../messages';

const SCOPE = 'sw';

export async function handleListSessions(m: ListSessionsReq): Promise<ListSessionsResp> {
  const sessions = await listSessions({ limit: m.limit ?? 100 });
  return {
    type: 'LIST_SESSIONS_RESP',
    sessions: sessions.map(summarise),
  };
}

function summarise(s: SessionState): SessionSummary {
  let preview = '';
  let toolCallCount = 0;
  for (const t of s.history) {
    if (!preview && t.role === 'user') preview = t.displayText ?? t.text;
    if (t.role === 'tool_trace') toolCallCount += 1;
  }
  return {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: s.status,
    iterations: s.iterations,
    preview: preview.slice(0, 200),
    turnCount: s.history.filter((t) => t.role === 'user' || t.role === 'assistant').length,
    toolCallCount,
    ...(s.schedule ? { scheduleLabel: s.schedule.label } : {}),
  };
}

export async function handleGetSession(m: GetSessionReq): Promise<GetSessionResp> {
  const s = await loadSession(m.sessionId);
  return { type: 'GET_SESSION_RESP', session: s };
}

export async function handleDeleteSession(m: DeleteSessionReq): Promise<void> {
  log(SCOPE, `DELETE_SESSION ${m.sessionId}`);
  const entry = activeSessions.get(m.sessionId);
  if (entry) {
    // Stop any in-flight work before we delete the persisted row.
    entry.abort.abort();
    activeSessions.delete(m.sessionId);
  }
  await deleteSession(m.sessionId);
}
