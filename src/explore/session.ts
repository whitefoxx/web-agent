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
import { log, warn } from '../runtime/log';
import { createPageShim, type PageShim } from '../runtime/page';
import {
  createNetworkRecorder,
  type CapturedNetworkEvent,
  type NetworkRecorderHandle,
} from '../runtime/network-recorder';
import type { TraceActionEvent, TraceStateEvent, TraceStatus } from './types';

export interface ExploreSessionInit {
  traceId: string;
  tabId: number;
  site?: string;
  task?: string;
  url?: string;
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
  readonly site?: string;
  readonly recorder: Recorder;
  private netHandle: NetworkRecorderHandle | null = null;
  private readonly netSummary = new Map<string, NetSummaryItem>();
  private stopped = false;

  private constructor(init: ExploreSessionInit, recorder: Recorder) {
    this.traceId = init.traceId;
    this.tabId = init.tabId;
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
