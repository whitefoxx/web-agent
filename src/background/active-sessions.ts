/**
 * The engine's in-memory session registry — FULL-shell only.
 *
 * Split out of runtime-state.ts (P4, docs/architecture.md §A): `ActiveSession`
 * holds a `SessionState`, which drags the whole `agent/*` subsystem in at
 * compile time. runtime-state.ts is part of the shared base (the lean shells'
 * service workers import it for the keep-alive + `sendToSidepanel` / `msgOf`),
 * so it must not carry that edge. The base keep-alive learns whether a session
 * is running through a probe (`setActiveSessionProbe`) the full SW wires to this
 * map at boot — never by importing it.
 *
 * Everything here is LOST when the MV3 worker is recycled; the boot path rebuilds
 * or recovers it (durable session state lives in IndexedDB via `SessionState`).
 */

import type { SessionState } from '../agent/session';

export interface ActiveSession {
  session: SessionState;
  abort: AbortController;
}

/** Sessions currently being driven by an engine. Cleared when finished /
 * aborted. The session object itself is also persisted via IDB — restart-
 * safe state lives in `SessionState`. */
export const activeSessions = new Map<string, ActiveSession>();
