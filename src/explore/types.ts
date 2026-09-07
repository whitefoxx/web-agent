/**
 * Trace data model for the LLM explore → synthesize → replay feature.
 *
 * Field names mirror opencli's observation event streams
 * (opencli/src/observation/events.ts) so a trace recorded here exports to an
 * opencli trace bundle with a near-identity mapping (goal 2 interop). See
 * docs/llm-explore.md.
 */

/** One stream per kind of observation, same vocabulary as opencli. */
export type ExploreStream = 'action' | 'network' | 'state' | 'console' | 'error';

interface BaseTraceEvent {
  /** Monotonic per-trace sequence number (also the secondary key in IDB). */
  seq: number;
  /** Epoch ms when the event was recorded. */
  ts: number;
  stream: ExploreStream;
}

/** A tool/primitive the agent invoked during explore. */
export interface TraceActionEvent extends BaseTraceEvent {
  stream: 'action';
  /** Tool name as the LLM called it, e.g. `open_url`, `xiaohongshu__comments`. */
  tool: string;
  args?: Record<string, unknown>;
  status: 'ok' | 'fail';
  durationMs?: number;
  /** Short, truncated summary of the result (NOT the full payload). */
  resultDigest?: string;
  errorMessage?: string;
}

/** An XHR/Fetch observed on the explore tab. The richest stream — this is
 * where signed endpoints + response schemas are discovered for synthesis. */
export interface TraceNetworkEvent extends BaseTraceEvent {
  stream: 'network';
  /** Where the record came from. `cdp` = CDP Network domain (our default,
   * protocol-level). `fetch`/`xhr` reserved for a page-injected shim fallback. */
  source: 'cdp' | 'fetch' | 'xhr';
  url: string;
  method: string;
  status?: number;
  /** CDP resource type, e.g. `XHR` | `Fetch`. */
  resourceType?: string;
  contentType?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  /** Possibly truncated; see responseBodyTruncated. */
  responseBody?: string;
  /** Full body size in chars before truncation. */
  responseBodyFullSize?: number;
  responseBodyTruncated?: boolean;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/** A point-in-time page snapshot (after a navigation / before extraction). */
export interface TraceStateEvent extends BaseTraceEvent {
  stream: 'state';
  url?: string;
  title?: string;
  label?: string;
  /** Captured DOM HTML (possibly truncated). */
  html?: string;
  /** Optional structured snapshot (interactives, a11y tree, …). */
  snapshot?: unknown;
}

export interface TraceConsoleEvent extends BaseTraceEvent {
  stream: 'console';
  level: string;
  text: string;
}

export interface TraceErrorEvent extends BaseTraceEvent {
  stream: 'error';
  code?: string;
  message: string;
  stack?: string;
}

export type TraceEvent =
  | TraceActionEvent
  | TraceNetworkEvent
  | TraceStateEvent
  | TraceConsoleEvent
  | TraceErrorEvent;

/** Per-stream-kind partial accepted by the recorder (seq + ts are assigned). */
export type TraceEventInput =
  | Omit<TraceActionEvent, 'seq' | 'ts'>
  | Omit<TraceNetworkEvent, 'seq' | 'ts'>
  | Omit<TraceStateEvent, 'seq' | 'ts'>
  | Omit<TraceConsoleEvent, 'seq' | 'ts'>
  | Omit<TraceErrorEvent, 'seq' | 'ts'>;

export type TraceStatus = 'recording' | 'done' | 'aborted';

/** Trace metadata record (the `traces` object store). */
export interface TraceMeta {
  /** Primary key. */
  traceId: string;
  site?: string;
  task?: string;
  /** Initial / primary URL explored. */
  url?: string;
  status: TraceStatus;
  startedAt: number;
  updatedAt: number;
  /** Per-stream event counts (kept on the meta for cheap listing/UI). */
  counts: Record<ExploreStream, number>;
}

/** A full trace: metadata + all events (used by readers/synthesis). */
export interface Trace extends TraceMeta {
  events: TraceEvent[];
}

export function emptyCounts(): Record<ExploreStream, number> {
  return { action: 0, network: 0, state: 0, console: 0, error: 0 };
}

/* ───────── Explore v2: site memory (atomic reuse) ───────── */

/** One durable, reusable fact the agent learned while exploring a site — kept
 * even when the adapter it was building never passed, so a later explore of the
 * same site builds on it instead of re-deriving. See docs/llm-explore.md. */
export interface Finding {
  id: string;
  /** What kind of fact: a data endpoint, a working selector, a step that worked,
   * a login/auth observation, or a free-form note. */
  kind: 'endpoint' | 'selector' | 'step' | 'fact' | 'login' | 'adapter';
  /** Human/agent-readable one-liner (the thing to remember). */
  text: string;
  /** Optional structured detail (e.g. {url, method} or {selector}). */
  detail?: unknown;
  /** Which trace this was learned from. */
  fromTraceId?: string;
  ts: number;
}

/** Per-site accumulated knowledge (the `site_memory` object store). */
export interface SiteMemory {
  /** Primary key — site identifier (lowercase, e.g. `zhihu`). */
  site: string;
  findings: Finding[];
  updatedAt: number;
}
