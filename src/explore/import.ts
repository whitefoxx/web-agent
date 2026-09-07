/**
 * Import an external trace and normalize it to our Trace shape so it can be
 * synthesized like a locally-recorded one. Supports:
 *
 *  1. Our own exported format — a single JSON object `{ traceId?, site?, task?,
 *     url?, events: TraceEvent[] }` (what "download trace" produces). Round-trips.
 *  2. opencli JSONL — `trace.jsonl` / `network.jsonl`: one observation event per
 *     line (opencli's ObservationEvent shapes). Mapped onto our streams.
 *
 * Pure (no FS / chrome) so it unit-tests in node. Screenshot/state events that
 * reference files on disk (opencli stores those as paths) can't be resolved
 * in-extension and are dropped — network bodies, the synthesis-critical signal,
 * are inline in the JSONL and survive. See docs/llm-explore.md.
 */

import {
  emptyCounts,
  type ExploreStream,
  type Trace,
  type TraceEvent,
  type TraceMeta,
} from './types';

interface RawEvent {
  stream?: string;
  ts?: number;
  [k: string]: unknown;
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function asHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = typeof val === 'string' ? val : String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map one opencli observation event onto our TraceEvent (seq filled later). */
function mapOpencliEvent(e: RawEvent): TraceEvent | null {
  const ts = typeof e.ts === 'number' ? e.ts : 0;
  switch (e.stream) {
    case 'action': {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const argv = data.argv;
      return {
        stream: 'action',
        seq: 0,
        ts,
        tool: typeof e.name === 'string' ? e.name : 'action',
        args: Array.isArray(argv)
          ? { argv }
          : e.data && typeof e.data === 'object'
            ? data
            : undefined,
        status: e.phase === 'error' ? 'fail' : 'ok',
        durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
        errorMessage: typeof data.errorMessage === 'string' ? data.errorMessage : undefined,
      };
    }
    case 'network':
      return {
        stream: 'network',
        seq: 0,
        ts,
        source: 'fetch',
        url: typeof e.url === 'string' ? e.url : '',
        method: typeof e.method === 'string' ? e.method : 'GET',
        status: typeof e.status === 'number' ? e.status : undefined,
        contentType: typeof e.contentType === 'string' ? e.contentType : undefined,
        requestHeaders: asHeaders(e.requestHeaders),
        requestBody: asString(e.requestBody),
        responseHeaders: asHeaders(e.responseHeaders),
        responseBody: asString(e.responseBody),
      };
    case 'state':
      return {
        stream: 'state',
        seq: 0,
        ts,
        url: typeof e.url === 'string' ? e.url : undefined,
        label: typeof e.label === 'string' ? e.label : undefined,
        // opencli inlines a DOM/AX snapshot string OR stores a file path; keep
        // strings as html, objects as the structured snapshot, drop paths.
        html: typeof e.snapshot === 'string' ? e.snapshot : undefined,
        snapshot: e.snapshot && typeof e.snapshot === 'object' ? e.snapshot : undefined,
      };
    case 'console':
      return {
        stream: 'console',
        seq: 0,
        ts,
        level: typeof e.level === 'string' ? e.level : 'log',
        text: asString(e.text) ?? '',
      };
    case 'error':
      return {
        stream: 'error',
        seq: 0,
        ts,
        message: asString(e.message) ?? 'error',
        code: typeof e.code === 'string' ? e.code : undefined,
        stack: typeof e.stack === 'string' ? e.stack : undefined,
      };
    default:
      return null; // screenshot + unknown streams skipped
  }
}

function finalize(traceId: string, events: TraceEvent[], meta: Partial<TraceMeta> = {}): Trace {
  const counts = emptyCounts();
  for (const ev of events) counts[ev.stream] = (counts[ev.stream] ?? 0) + 1;
  const stamps = events.map((e) => e.ts).filter((t) => typeof t === 'number' && t > 0);
  const startedAt = meta.startedAt ?? (stamps.length ? Math.min(...stamps) : 0);
  const updatedAt = meta.updatedAt ?? (stamps.length ? Math.max(...stamps) : startedAt);
  const firstUrl =
    events.find((e): e is Extract<TraceEvent, { stream: 'network' }> => e.stream === 'network')
      ?.url ||
    events.find((e): e is Extract<TraceEvent, { stream: 'state' }> => e.stream === 'state')?.url;
  return {
    traceId,
    site: meta.site,
    task: meta.task,
    url: meta.url ?? firstUrl,
    status: 'done',
    startedAt,
    updatedAt,
    counts,
    events,
  };
}

/** A coarse stream tag for ExploreStream typing of counts. */
function isStream(s: string): s is ExploreStream {
  return s === 'action' || s === 'network' || s === 'state' || s === 'console' || s === 'error';
}

/**
 * Parse an imported trace file's text into our Trace. `traceId` is supplied by
 * the caller (the SW generates a fresh `import_…` id). Returns null when the
 * text yields no usable events.
 */
export function parseTraceImport(text: string, traceId: string): Trace | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // (1) Our own exported single-object format.
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as {
        events?: unknown;
        site?: string;
        task?: string;
        url?: string;
      };
      if (obj && Array.isArray(obj.events)) {
        const events = (obj.events as TraceEvent[])
          .filter((e) => e && typeof e === 'object' && isStream((e as TraceEvent).stream))
          .map((e, i) => ({ ...e, seq: i, ts: typeof e.ts === 'number' ? e.ts : i }) as TraceEvent);
        if (!events.length) return null;
        return finalize(traceId, events, { site: obj.site, task: obj.task, url: obj.url });
      }
    } catch {
      /* not our JSON → fall through to JSONL */
    }
  }

  // (2) opencli JSONL (trace.jsonl / network.jsonl): one event per line.
  const events: TraceEvent[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue; // skip blanks / markdown / non-object lines
    let raw: RawEvent;
    try {
      raw = JSON.parse(s) as RawEvent;
    } catch {
      continue;
    }
    const mapped = mapOpencliEvent(raw);
    if (mapped) events.push({ ...mapped, seq: events.length });
  }
  if (!events.length) return null;
  return finalize(traceId, events);
}
