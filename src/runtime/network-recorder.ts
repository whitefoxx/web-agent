/**
 * Session-level CDP network capture for explore.
 *
 * Unlike PageShim.captureNetwork (single-match, per-action), this keeps the
 * Network domain enabled for the whole explore session and streams EVERY
 * XHR/Fetch — request headers/body, response status/headers, and response body
 * — to a callback. This is what surfaces signed endpoints + response schemas
 * for synthesis (docs/llm-explore.md).
 *
 * Capture is at the CDP protocol level, so it sees the real wire request
 * (cookies + signing headers Chrome added) — strictly more than a page-injected
 * fetch/XHR shim.
 *
 * Debugger ownership: if the tab is already attached (e.g. by a PageShim), we
 * tolerate the failed attach and DON'T tear down the shared session on stop().
 * P2 wires this so the explore tab's attachment is owned for the session.
 */

import { log, warn } from '@base/runtime/log';
import type { TraceNetworkEvent } from '../explore/types';

type DebugTarget = chrome.debugger.Debuggee;

/** The network event shape handed to the callback (recorder adds seq/ts). */
export type CapturedNetworkEvent = Omit<TraceNetworkEvent, 'seq' | 'ts'>;

export interface NetworkRecorderHandle {
  stop(): Promise<void>;
}

interface PartialRequest {
  url: string;
  method: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  resourceType?: string;
  status?: number;
  contentType?: string;
  responseHeaders?: Record<string, string>;
  startedAt?: number;
}

const CAPTURED_TYPES = new Set(['XHR', 'Fetch']);

function isJsonish(contentType?: string): boolean {
  if (!contentType) return true; // unknown — keep, let synthesis decide
  return /json|text|javascript|xml|form-urlencoded/i.test(contentType);
}

/**
 * Start capturing XHR/Fetch on `tabId`, calling `onEvent` once per completed
 * (or failed) request with the full normalized record. Returns a handle whose
 * `stop()` removes the listener (and tears down the Network domain only if we
 * were the ones who attached).
 */
export async function createNetworkRecorder(
  tabId: number,
  onEvent: (e: CapturedNetworkEvent) => void,
  opts: { maxBodyChars?: number } = {},
): Promise<NetworkRecorderHandle> {
  const target: DebugTarget = { tabId };
  const maxBodyChars = opts.maxBodyChars ?? 2 * 1024 * 1024;
  const inflight = new Map<string, PartialRequest>();

  let didAttach = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    didAttach = true;
  } catch (e) {
    // Most likely already attached by a PageShim on this tab. Enable Network
    // on the existing session; leave teardown to whoever attached.
    warn('network-recorder', `attach failed (already attached?) tabId=${tabId}`, e);
  }
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
  } catch (e) {
    // enable failed after we attached — don't leak the attachment (stuck
    // "being debugged" banner + blocks future attaches). Detach only what WE
    // attached, then rethrow. See §10.30.
    if (didAttach) await chrome.debugger.detach(target).catch(() => {});
    throw e;
  }
  log('network-recorder', `capture started tabId=${tabId} didAttach=${didAttach}`);

  const emit = (requestId: string, extra: Partial<CapturedNetworkEvent>): void => {
    const p = inflight.get(requestId);
    inflight.delete(requestId);
    if (!p) return;
    if (p.resourceType && !CAPTURED_TYPES.has(p.resourceType)) return;
    onEvent({
      stream: 'network',
      source: 'cdp',
      url: p.url,
      method: p.method,
      status: p.status,
      resourceType: p.resourceType,
      contentType: p.contentType,
      requestHeaders: p.requestHeaders,
      requestBody: p.requestBody,
      responseHeaders: p.responseHeaders,
      startedAt: p.startedAt,
      finishedAt: Date.now(),
      ...extra,
    });
  };

  const handler = async (source: DebugTarget, method: string, params?: unknown): Promise<void> => {
    if (source.tabId !== tabId) return;
    try {
      if (method === 'Network.requestWillBeSent') {
        const p = params as {
          requestId: string;
          type?: string;
          request: {
            url: string;
            method: string;
            headers?: Record<string, string>;
            postData?: string;
          };
        };
        inflight.set(p.requestId, {
          url: p.request.url,
          method: p.request.method,
          requestHeaders: p.request.headers,
          requestBody: p.request.postData,
          resourceType: p.type,
          startedAt: Date.now(),
        });
      } else if (method === 'Network.responseReceived') {
        const p = params as {
          requestId: string;
          type?: string;
          response: { status: number; headers?: Record<string, string>; mimeType?: string };
        };
        const cur = inflight.get(p.requestId);
        if (!cur) return;
        cur.status = p.response.status;
        cur.responseHeaders = p.response.headers;
        cur.contentType = p.response.mimeType;
        if (p.type) cur.resourceType = p.type;
      } else if (method === 'Network.loadingFinished') {
        const p = params as { requestId: string };
        const cur = inflight.get(p.requestId);
        if (!cur || (cur.resourceType && !CAPTURED_TYPES.has(cur.resourceType))) {
          inflight.delete(p.requestId);
          return;
        }
        let responseBody: string | undefined;
        let fullSize: number | undefined;
        let truncated = false;
        if (isJsonish(cur.contentType)) {
          try {
            const raw = (await chrome.debugger.sendCommand(target, 'Network.getResponseBody', {
              requestId: p.requestId,
            })) as { body: string; base64Encoded: boolean };
            const text = raw.base64Encoded ? atob(raw.body) : raw.body;
            fullSize = text.length;
            responseBody = text.length > maxBodyChars ? text.slice(0, maxBodyChars) : text;
            truncated = text.length > maxBodyChars;
          } catch {
            /* body unavailable (e.g. served from cache / already evicted) */
          }
        }
        emit(p.requestId, {
          responseBody,
          responseBodyFullSize: fullSize,
          responseBodyTruncated: truncated,
        });
      } else if (method === 'Network.loadingFailed') {
        const p = params as { requestId: string; errorText?: string; type?: string };
        const cur = inflight.get(p.requestId);
        if (cur && p.type) cur.resourceType = p.type;
        emit(p.requestId, { error: p.errorText ?? 'loadingFailed' });
      }
    } catch (e) {
      warn('network-recorder', 'handler error', e);
    }
  };

  chrome.debugger.onEvent.addListener(handler);

  return {
    async stop(): Promise<void> {
      chrome.debugger.onEvent.removeListener(handler);
      inflight.clear();
      // Only tear down the Network domain / detach if WE attached. If a
      // PageShim owns the attachment, leave its session intact.
      if (didAttach) {
        try {
          await chrome.debugger.sendCommand(target, 'Network.disable', {});
        } catch {
          /* tab may be gone */
        }
        try {
          await chrome.debugger.detach(target);
        } catch {
          /* already detached / tab closed */
        }
      }
      log('network-recorder', `capture stopped tabId=${tabId}`);
    },
  };
}
