/**
 * Recorder — accumulates the explore streams (action / network / state /
 * console / error) for one trace and flushes them incrementally to a sink.
 *
 * Design constraints (see docs/llm-explore.md):
 *  - Persistence is INJECTED (`sinks`), defaulting to trace-store. This keeps
 *    the buffering / truncation / sequencing logic unit-testable in node with
 *    no IndexedDB.
 *  - Network bodies are truncated per-body and capped per-session so a trace
 *    can't grow without bound.
 *  - Flushing is incremental (threshold-based, plus an optional timer P2 turns
 *    on) so an SW kill mid-explore leaves a recoverable partial trace.
 */

import {
  emptyCounts,
  type ExploreStream,
  type TraceEvent,
  type TraceEventInput,
  type TraceMeta,
  type TraceStatus,
} from './types';
import {
  appendEvents as defaultAppendEvents,
  updateTraceMeta as defaultUpdateMeta,
} from './trace-store';

export interface RecorderSinks {
  /** Persist a batch of events for the trace. */
  events?: (traceId: string, events: TraceEvent[]) => void | Promise<void>;
  /** Persist (upsert) the trace metadata. */
  meta?: (meta: TraceMeta) => void | Promise<void>;
}

export interface RecorderOptions {
  /** Per-response-body char cap; longer bodies are truncated. Default 512 KiB. */
  maxBodyChars?: number;
  /** Session-wide response-body char budget; once exceeded, bodies are dropped
   * (metadata still recorded). Default 16 MiB. */
  maxTotalBodyChars?: number;
  /** Flush after this many buffered events. Default 16. */
  flushEveryN?: number;
  /** Optional auto-flush interval (ms). Off by default; P2 enables it for live
   * crash-recovery. */
  flushIntervalMs?: number;
  /** Cap for action resultDigest length. Default 2000. */
  maxDigestChars?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
}

export interface RecorderInit {
  traceId: string;
  site?: string;
  task?: string;
  url?: string;
}

const DEFAULTS = {
  maxBodyChars: 512 * 1024,
  maxTotalBodyChars: 16 * 1024 * 1024,
  flushEveryN: 16,
  maxDigestChars: 2000,
};

export class Recorder {
  readonly meta: TraceMeta;
  private seq = 0;
  private pending: TraceEvent[] = [];
  private totalBodyChars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private readonly opts: Required<Omit<RecorderOptions, 'flushIntervalMs'>> & {
    flushIntervalMs?: number;
  };
  private readonly sinks: Required<RecorderSinks>;

  constructor(meta: TraceMeta, opts: RecorderOptions = {}, sinks: RecorderSinks = {}) {
    this.meta = meta;
    this.opts = {
      maxBodyChars: opts.maxBodyChars ?? DEFAULTS.maxBodyChars,
      maxTotalBodyChars: opts.maxTotalBodyChars ?? DEFAULTS.maxTotalBodyChars,
      flushEveryN: opts.flushEveryN ?? DEFAULTS.flushEveryN,
      maxDigestChars: opts.maxDigestChars ?? DEFAULTS.maxDigestChars,
      now: opts.now ?? Date.now,
      flushIntervalMs: opts.flushIntervalMs,
    };
    this.sinks = {
      events: sinks.events ?? defaultAppendEvents,
      meta: sinks.meta ?? defaultUpdateMeta,
    };
  }

  /** Build a fresh recording trace and persist its initial metadata. */
  static async create(
    init: RecorderInit,
    opts: RecorderOptions = {},
    sinks: RecorderSinks = {},
  ): Promise<Recorder> {
    const now = (opts.now ?? Date.now)();
    const meta: TraceMeta = {
      traceId: init.traceId,
      site: init.site,
      task: init.task,
      url: init.url,
      status: 'recording',
      startedAt: now,
      updatedAt: now,
      counts: emptyCounts(),
    };
    const r = new Recorder(meta, opts, sinks);
    await r.persistMeta();
    return r;
  }

  recordAction(e: Omit<import('./types').TraceActionEvent, 'seq' | 'ts'>): void {
    const digest =
      typeof e.resultDigest === 'string'
        ? e.resultDigest.slice(0, this.opts.maxDigestChars)
        : e.resultDigest;
    this.push({ ...e, resultDigest: digest });
  }

  recordNetwork(e: Omit<import('./types').TraceNetworkEvent, 'seq' | 'ts'>): void {
    this.push(this.truncateBody(e));
  }

  recordState(e: Omit<import('./types').TraceStateEvent, 'seq' | 'ts'>): void {
    this.push(e);
  }

  recordConsole(e: Omit<import('./types').TraceConsoleEvent, 'seq' | 'ts'>): void {
    this.push(e);
  }

  recordError(e: Omit<import('./types').TraceErrorEvent, 'seq' | 'ts'>): void {
    this.push(e);
  }

  /** Number of events buffered but not yet flushed (test/diagnostic aid). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Flush buffered events + metadata to the sinks. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) {
      await this.persistMeta();
      return;
    }
    const batch = this.pending;
    this.pending = [];
    await this.sinks.events(this.meta.traceId, batch);
    await this.persistMeta();
  }

  /** Flush remaining events and mark the trace terminal. */
  async finalize(status: Exclude<TraceStatus, 'recording'> = 'done'): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.meta.status = status;
    await this.flush();
  }

  private async persistMeta(): Promise<void> {
    this.meta.updatedAt = this.opts.now();
    await this.sinks.meta(this.meta);
  }

  private truncateBody(
    e: Omit<import('./types').TraceNetworkEvent, 'seq' | 'ts'>,
  ): Omit<import('./types').TraceNetworkEvent, 'seq' | 'ts'> {
    const body = e.responseBody;
    if (typeof body !== 'string' || body.length === 0) return e;
    const full = body.length;
    // Session budget exhausted: keep the record, drop the body.
    if (this.totalBodyChars >= this.opts.maxTotalBodyChars) {
      return {
        ...e,
        responseBody: undefined,
        responseBodyFullSize: full,
        responseBodyTruncated: true,
      };
    }
    let kept = body;
    let truncated = false;
    if (full > this.opts.maxBodyChars) {
      kept = body.slice(0, this.opts.maxBodyChars);
      truncated = true;
    }
    this.totalBodyChars += kept.length;
    return {
      ...e,
      responseBody: kept,
      responseBodyFullSize: full,
      responseBodyTruncated: truncated || e.responseBodyTruncated || false,
    };
  }

  private push(input: TraceEventInput): void {
    if (this.finalized) return;
    const ev = { ...input, seq: this.seq++, ts: this.opts.now() } as TraceEvent;
    this.pending.push(ev);
    this.bumpCount(ev.stream);
    if (this.pending.length >= this.opts.flushEveryN) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private bumpCount(stream: ExploreStream): void {
    this.meta.counts[stream] = (this.meta.counts[stream] ?? 0) + 1;
  }

  private scheduleFlush(): void {
    if (this.opts.flushIntervalMs == null || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.opts.flushIntervalMs);
  }
}
