/**
 * ExploreSession — the headless "explore engine". Ties together the P1
 * substrate (Recorder + trace-store) and the CDP session-level network
 * capture, owns the explore tab's debugger attachment for the whole session,
 * and exposes the hooks the rest of the system records through:
 *
 *   - recordAction()  ← dispatcher, per tool call
 *   - recordState()   ← navigations / pre-extraction snapshots
 *   - networkSummary() → list_network primitive
 *   - newPage()       → get_html primitive (reuses the session attachment)
 *
 * Debugger ownership: the network recorder performs the attach (it is created
 * first), so it OWNS the attachment. Every PageShim created afterwards on the
 * same tab (session.newPage(), or a per-tool dispatcher shim during explore)
 * reuses it and skips detach (see page.ts ownsAttachment). The session is torn
 * down by stopping the network recorder, which detaches.
 *
 * Single active session at a time (one explore run, one process — the SW).
 * See docs/llm-explore.md.
 */

import { Recorder, type RecorderInit } from './recorder';
import { log, warn } from '@base/runtime/log';
import { createPageShim, type PageShim } from '@base/runtime/page';
import {
  createNetworkRecorder,
  type CapturedNetworkEvent,
  type NetworkRecorderHandle,
} from '../runtime/network-recorder';
import type { CapturedSubmission } from '../runtime/submission-capture';
import { getSiteMemory, addFinding, getTraceMeta, getTraceEvents } from './trace-store';
import type { TraceActionEvent, TraceStateEvent, TraceStatus, Finding } from './types';

export interface ExploreSessionInit {
  traceId: string;
  tabId: number;
  site?: string;
  task?: string;
  url?: string;
  /** Who drives this explore (F-30 isolation): the chat sessionId for a SidePanel
   * run, `'bridge'` for an external-agent run. The dispatcher records a tool call
   * into the trace ONLY when the call's origin matches this — so a bridge call
   * can't contaminate a SidePanel explore trace (and vice-versa). */
  owner?: string;
}

/** Should a tool call with `origin` be recorded into an explore session owned by
 * `owner`? Untagged callers (undefined origin — e.g. verify smoke-tests) always
 * record; a tagged caller records only into its own session (F-30). Pure. */
export function exploreShouldRecord(
  owner: string | undefined,
  origin: string | undefined,
): boolean {
  return !origin || owner === origin;
}

/** One deduped endpoint in the live network summary (for list_network). */
export interface NetSummaryItem {
  method: string;
  /** origin + pathname, query stripped (collapses signed/volatile params). */
  endpoint: string;
  /** A representative full URL (most recent), query intact. */
  sampleUrl: string;
  status?: number;
  contentType?: string;
  resourceType?: string;
  hasBody: boolean;
  count: number;
}

/** Injectable construction deps so the orchestration unit-tests without CDP. */
export interface ExploreDeps {
  createRecorder?: (init: RecorderInit) => Promise<Recorder>;
  createNetworkRecorder?: (
    tabId: number,
    onEvent: (e: CapturedNetworkEvent) => void,
  ) => Promise<NetworkRecorderHandle>;
}

/** method + origin + pathname (query stripped). */
export function endpointKey(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method} ${u.origin}${u.pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}

/** Fold a captured network event into the deduped summary map (pure; tested). */
export function mergeNetSummary(map: Map<string, NetSummaryItem>, e: CapturedNetworkEvent): void {
  const key = endpointKey(e.method, e.url);
  const existing = map.get(key);
  const hasBody = typeof e.responseBody === 'string' && e.responseBody.length > 0;
  if (existing) {
    existing.count += 1;
    existing.sampleUrl = e.url;
    if (e.status !== undefined) existing.status = e.status;
    if (e.contentType) existing.contentType = e.contentType;
    if (e.resourceType) existing.resourceType = e.resourceType;
    if (hasBody) existing.hasBody = true;
    return;
  }
  map.set(key, {
    method: e.method,
    endpoint: key.slice(e.method.length + 1),
    sampleUrl: e.url,
    status: e.status,
    contentType: e.contentType,
    resourceType: e.resourceType,
    hasBody,
    count: 1,
  });
}

export class ExploreSession {
  readonly traceId: string;
  readonly tabId: number;
  /** Driver identity for F-30 isolation (see ExploreSessionInit.owner). */
  readonly owner?: string;
  /** Resolved from the first navigation; used to name + group adapters. */
  site?: string;
  readonly recorder: Recorder;
  private netHandle: NetworkRecorderHandle | null = null;
  private readonly netSummary = new Map<string, NetSummaryItem>();
  private stopped = false;
  /** Slice boundary: events with seq >= cursor belong to the operation the
   * agent is currently exploring (since the last synthesize_adapter). */
  private _cursor = 0;
  /** How many adapters have been synthesized this session (for stable ids). */
  private _adapterCount = 0;
  /** Per-site reusable findings (loaded when the site is resolved; appended to
   * as the agent learns). Injected into the explore prompt so a later run builds
   * on prior knowledge instead of re-deriving it. */
  private _findings: Finding[] = [];
  private _findingSeq = 0;
  /** Last synthesis attempt per adapter name → fed back as `repair` so a retry
   * with the same name FIXES the previous source instead of regenerating blind
   * (turns the agent's "try again" into a real debug loop). */
  private _attempts = new Map<string, { source: string; error: string }>();
  /** The most recent array the agent extracted live via eval_js — the ground
   * truth for the differential correctness check (A1): the synthesized adapter
   * should reproduce roughly this. Capped to keep memory bounded. */
  private _lastExtraction: unknown[] | null = null;
  /** The eval_js CODE that produced _lastExtraction — fed verbatim to synthesis
   * so the proven snippet doesn't depend on the agent pasting it into notes. */
  private _lastExtractionCode: string | null = null;
  /** Write requests captured (and neutralized) via capture_submission during the
   * current operation — the real evidence a WRITE adapter is synthesized from
   * (F-29 constructive fix). Per-operation, like _lastExtraction. */
  private _submissions: CapturedSubmission[] = [];

  private constructor(init: ExploreSessionInit, recorder: Recorder) {
    this.traceId = init.traceId;
    this.tabId = init.tabId;
    this.owner = init.owner;
    this.site = init.site;
    this.recorder = recorder;
  }

  /** Start a session: create the trace, begin network capture, mark active. */
  static async start(init: ExploreSessionInit, deps: ExploreDeps = {}): Promise<ExploreSession> {
    if (_active && !_active.stopped) {
      throw new Error(
        `an explore session is already active (traceId=${_active.traceId}); stop it first`,
      );
    }
    const mkRec =
      deps.createRecorder ?? ((i: RecorderInit) => Recorder.create(i, { flushIntervalMs: 1500 }));
    const mkNet = deps.createNetworkRecorder ?? createNetworkRecorder;

    const recorder = await mkRec({
      traceId: init.traceId,
      site: init.site,
      task: init.task,
      url: init.url,
    });
    const session = new ExploreSession(init, recorder);
    // Created first → owns the tab's debugger attachment for the session.
    session.netHandle = await mkNet(init.tabId, (e) => session.onNetwork(e));
    _active = session;
    log('explore', `session started traceId=${init.traceId} tabId=${init.tabId} site=${init.site}`);
    return session;
  }

  /** Resume an explore session bound to an EXISTING trace (append). Used when a
   * follow-up turn continues a prior explore run (E4 resume): the recorder picks
   * up the seq where it left off, and cursor / adapterCount / site are restored.
   * Falls back to a fresh recorder if the stored trace is gone. */
  static async resume(
    init: {
      traceId: string;
      tabId: number;
      site?: string;
      cursor: number;
      adapterCount: number;
      owner?: string;
    },
    deps: ExploreDeps = {},
  ): Promise<ExploreSession> {
    if (_active && !_active.stopped) {
      throw new Error(
        `an explore session is already active (traceId=${_active.traceId}); stop it first`,
      );
    }
    const mkNet = deps.createNetworkRecorder ?? createNetworkRecorder;
    let recorder: Recorder;
    const meta = deps.createRecorder ? null : await getTraceMeta(init.traceId);
    if (meta) {
      const events = await getTraceEvents(init.traceId);
      const startSeq = events.reduce((m, e) => Math.max(m, e.seq + 1), 0);
      recorder = await Recorder.resume(meta, startSeq, { flushIntervalMs: 1500 });
    } else {
      const mkRec =
        deps.createRecorder ?? ((i: RecorderInit) => Recorder.create(i, { flushIntervalMs: 1500 }));
      recorder = await mkRec({ traceId: init.traceId, site: init.site });
    }
    const session = new ExploreSession(
      { traceId: init.traceId, tabId: init.tabId, site: init.site, owner: init.owner },
      recorder,
    );
    session._cursor = init.cursor;
    session._adapterCount = init.adapterCount;
    session.netHandle = await mkNet(init.tabId, (e) => session.onNetwork(e));
    _active = session;
    if (init.site) session.loadFindings(init.site);
    log(
      'explore',
      `session resumed traceId=${init.traceId} tabId=${init.tabId} cursor=${init.cursor} adapters=${init.adapterCount}`,
    );
    return session;
  }

  private onNetwork(e: CapturedNetworkEvent): void {
    this.recorder.recordNetwork(e);
    mergeNetSummary(this.netSummary, e);
  }

  recordAction(e: Omit<TraceActionEvent, 'seq' | 'ts'>): void {
    this.recorder.recordAction(e);
  }

  recordState(e: Omit<TraceStateEvent, 'seq' | 'ts'>): void {
    this.recorder.recordState(e);
  }

  /** Deduped endpoints seen so far, most-recently-updated first. */
  networkSummary(): NetSummaryItem[] {
    return [...this.netSummary.values()];
  }

  /** Slice boundary for the next synthesis (first seq of the current op). */
  get cursor(): number {
    return this._cursor;
  }

  /** Mark the current operation done: the next synthesis slices from here, and
   * the live-extraction ground truth resets for the next operation. */
  advanceCursor(): void {
    this._cursor = this.recorder.nextSeq;
    this._lastExtraction = null;
    this._lastExtractionCode = null;
    this._submissions = [];
  }

  /** Mint a stable id for the next synthesized adapter row. */
  nextAdapterId(): string {
    this._adapterCount += 1;
    return `${this.traceId}__a${this._adapterCount}`;
  }

  /** How many adapters the agent synthesized this session (gates the post-loop
   * backstop synth — skip it when the agent already produced ≥1). */
  get adapterCount(): number {
    return this._adapterCount;
  }

  /** The previous synthesis attempt for this adapter name (for repair), or null. */
  lastAttemptFor(name: string | undefined): { source: string; error: string } | null {
    return name ? (this._attempts.get(name) ?? null) : null;
  }

  /** Record the latest live-extracted array (from eval_js) as differential
   * ground truth, plus the code that produced it. Capped at 200 rows so a huge
   * result can't bloat the session. */
  recordExtraction(rows: unknown[], code?: string): void {
    this._lastExtraction = rows.slice(0, 200);
    this._lastExtractionCode = code?.trim() ? code : null;
  }

  /** The latest live-extracted array, or null. */
  lastExtraction(): unknown[] | null {
    return this._lastExtraction;
  }

  /** The eval_js code behind lastExtraction(), or null. */
  lastExtractionCode(): string | null {
    return this._lastExtractionCode;
  }

  /** Record write requests captured (and neutralized) by capture_submission, so
   * synthesis can build a WRITE adapter from the real request structure. Capped
   * to keep the session bounded. */
  recordSubmission(subs: CapturedSubmission[]): void {
    if (!subs.length) return;
    this._submissions.push(...subs);
    if (this._submissions.length > 50) this._submissions = this._submissions.slice(-50);
  }

  /** Captured write requests for the current operation (for synthesis), or []. */
  capturedSubmissions(): CapturedSubmission[] {
    return this._submissions;
  }

  /** Remember an attempt's source + error so the next same-name synth repairs it. */
  recordAttempt(name: string | undefined, source: string, error: string): void {
    if (name) this._attempts.set(name, { source, error });
  }

  /** Record the site once a navigation reveals it, and load any prior findings
   * for it (fire-and-forget — the prompt note picks them up once loaded). */
  setSite(site: string): void {
    if (!site || this.site) return;
    this.site = site;
    // Stamp it onto the trace meta too so the trace + synthesis digest carry the
    // site (persisted on the next flush).
    this.recorder.meta.site = site;
    this.loadFindings(site);
  }

  /** Merge stored site findings into the in-session list (fire-and-forget). */
  private loadFindings(site: string): void {
    void getSiteMemory(site)
      .then((mem) => {
        if (!mem?.findings?.length) return;
        // Keep any findings already recorded this session ahead of stored ones.
        const seen = new Set(this._findings.map((f) => f.text.trim().toLowerCase()));
        for (const f of mem.findings) {
          if (!seen.has(f.text.trim().toLowerCase())) this._findings.push(f);
        }
        this._findingSeq = Math.max(this._findingSeq, mem.findings.length);
        log('explore', `loaded ${mem.findings.length} prior finding(s) for site=${site}`);
      })
      .catch(() => {});
  }

  /** Reusable findings for the prompt, or '' if none. */
  findingsNote(): string {
    if (this._findings.length === 0) return '';
    const lines = this._findings.slice(-20).map((f) => `- (${f.kind}) ${f.text}`);
    return `\n\n## Known info about this site (reuse directly — don't re-explore)\n${lines.join('\n')}`;
  }

  /** Record a reusable finding: keep it in-session (for the prompt) and persist
   * it to the site's memory (best-effort). No-op until the site is known. */
  recordFinding(input: {
    kind: Finding['kind'];
    text: string;
    detail?: unknown;
    ts: number;
  }): void {
    if (!this.site || !input.text.trim()) return;
    const norm = input.text.trim().toLowerCase();
    if (this._findings.some((f) => f.text.trim().toLowerCase() === norm)) return;
    const finding: Finding = {
      id: `${this.traceId}__f${++this._findingSeq}`,
      kind: input.kind,
      text: input.text.trim(),
      detail: input.detail,
      fromTraceId: this.traceId,
      ts: input.ts,
    };
    this._findings.push(finding);
    void addFinding(this.site, finding).catch(() => {});
  }

  /** A PageShim on the explore tab. Reuses the session attachment (skips
   * detach), so calling .detach() on it is safe and won't stop capture. */
  newPage(): Promise<PageShim> {
    return createPageShim(this.tabId);
  }

  /** Flush + finalize the trace and tear down capture (detaches the tab). */
  async stop(status: Exclude<TraceStatus, 'recording'> = 'done'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Finalize first so any in-flight network event is ignored, then drop the
    // capture (which detaches the debugger).
    await this.recorder.finalize(status);
    if (this.netHandle) {
      try {
        await this.netHandle.stop();
      } catch (e) {
        warn('explore', 'network recorder stop failed', e);
      }
    }
    if (_active === this) _active = null;
    log('explore', `session stopped traceId=${this.traceId} status=${status}`);
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}

let _active: ExploreSession | null = null;

/** The active explore session, or null. Read by the dispatcher action hook
 * and the explore primitives. */
export function getActiveExploreSession(): ExploreSession | null {
  return _active && !_active.isStopped ? _active : null;
}
