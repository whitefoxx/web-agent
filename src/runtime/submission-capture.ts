/**
 * Offline submission capture — the CONSTRUCTIVE half of the F-29 write guard
 * (docs/browseract-comparison.md ①). While `eval_js`'s `detectWriteIntent`
 * only BLOCKS obvious writes (so the agent can't explore a write task at all),
 * this lets the agent perform the write for real in the UI while GUARANTEEING
 * the request never reaches the server — and hands back the request's full
 * structure (endpoint / method / body fields / GraphQL mutation) so a write
 * adapter can be synthesized from real evidence instead of guessed.
 *
 * Mechanism: CDP `Fetch` request-stage interception, scoped to the ONE tab we
 * attach to (chrome.debugger is per-target — same isolation the screenshot /
 * network-recorder tools already rely on; NOT browser-wide, not other tabs, not
 * other apps, not the OS). Every intercepted XHR/Fetch/Document request is
 * classified: a WRITE (PUT/PATCH/DELETE, a non-GraphQL POST, or a GraphQL
 * `mutation`) is CAPTURED then NEUTRALIZED (aborted — or optionally fulfilled
 * with a synthetic 200) so it dies on the machine; a READ (GET/HEAD, or a
 * GraphQL `query`/`subscription`) is continued untouched so the page keeps
 * working. Because writes are aborted (not queued), there is no "flip back
 * online → retry fires for real" hazard the blunt offline approach has.
 *
 * Debugger ownership mirrors network-recorder: if the tab is already attached
 * (e.g. the explore session's network recorder owns it), we tolerate the failed
 * attach and DON'T detach on stop() — only disable the Fetch domain.
 */

import { log, warn } from '@base/runtime/log';

type DebugTarget = chrome.debugger.Debuggee;

/** One captured (and neutralized) write request — the evidence for synthesizing
 * a write adapter. Sensitive header values are redacted before this leaves the
 * capture module (never into the trace / synthesis LLM). */
export interface CapturedSubmission {
  method: string;
  url: string;
  /** origin + pathname, query stripped — the stable endpoint key. */
  endpoint: string;
  resourceType?: string;
  /** Request headers, sensitive values (cookie/authorization/csrf) redacted to
   * `<redacted>` — the NAME is kept so synthesis knows the header is required. */
  headers: Record<string, string>;
  /** Parsed request body: a JSON object, a form-urlencoded object, or (fallback)
   * the raw string clipped. Undefined for a body-less request. */
  body?: unknown;
  /** Set when the body is a GraphQL operation — mutation = the write. */
  graphql?: { operation: string; operationName?: string };
  /** How the request was neutralized (never sent to the server). */
  neutralized: 'abort' | 'fulfill';
  ts: number;
}

export interface SubmissionCaptureHandle {
  /** Captured writes so far (live view; mutated as requests are intercepted). */
  readonly captured: CapturedSubmission[];
  /** Stop intercepting. Disables the Fetch domain and detaches ONLY if we were
   * the ones who attached. Returns the full captured list. */
  stop(): Promise<CapturedSubmission[]>;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
const MAX_BODY_CHARS = 4096;

/** Request headers whose VALUES are secrets — redact the value, keep the name so
 * synthesis still learns the header is part of the write contract. */
const SENSITIVE_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token|x-auth-token|x-api-key|api-key|x-secret)$/i;

/** Redact secret header values (keep names). Pure; unit-tested. */
export function redactHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER.test(k) ? '<redacted>' : v;
  }
  return out;
}

/** If `bodyText` is a GraphQL request, return its operation kind + name. Handles
 * the `{query,variables,operationName}` object and batched arrays (a mutation
 * anywhere in the batch ⇒ mutation). Pure; unit-tested. */
export function detectGraphql(
  bodyText: string | undefined,
): { operation: string; operationName?: string } | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const pick = (o: unknown): { operation: string; operationName?: string } | null => {
    if (!o || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    if (typeof rec.query !== 'string') return null;
    // First keyword of the document: mutation/query/subscription (skip # comments
    // and leading whitespace). An anonymous `{ ... }` document is a query.
    const m = /^\s*(?:#[^\n]*\n\s*)*(mutation|query|subscription)\b\s*([A-Za-z_]\w*)?/.exec(
      rec.query,
    );
    const operation = m?.[1] ?? 'query';
    const operationName =
      typeof rec.operationName === 'string' && rec.operationName ? rec.operationName : m?.[2];
    return operationName ? { operation, operationName } : { operation };
  };
  if (Array.isArray(parsed)) {
    for (const it of parsed) {
      const r = pick(it);
      if (r?.operation === 'mutation') return r;
    }
    return parsed.length ? pick(parsed[0]) : null;
  }
  return pick(parsed);
}

/** Classify an intercepted request as a write (to neutralize) or a read (to let
 * through). GraphQL is disambiguated by operation so a POST-based query isn't
 * broken; a non-GraphQL POST defaults to WRITE (safe bias — better to over-block
 * a stray read during the short armed window than to let a write land). Pure. */
export function classifySubmission(
  method: string,
  bodyText: string | undefined,
): { isWrite: boolean; graphql?: { operation: string; operationName?: string } } {
  const m = (method || 'GET').toUpperCase();
  if (READ_METHODS.has(m)) return { isWrite: false };
  const gql = detectGraphql(bodyText);
  if (gql) return { isWrite: gql.operation === 'mutation', graphql: gql };
  // PUT / PATCH / DELETE, or a non-GraphQL POST → treat as a write.
  return { isWrite: m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE' };
}

/** Turn a raw request body into a readable structured value for the record: a
 * JSON object, a form-urlencoded object, or the clipped raw string. Pure. */
export function parseBodyForRecord(bodyText: string | undefined, contentType: string): unknown {
  if (!bodyText) return undefined;
  const trimmed = bodyText.trim();
  if (/json/i.test(contentType) || /^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (
    /x-www-form-urlencoded/i.test(contentType) ||
    /^[^=&\s]+=[^&]*(?:&[^=&\s]+=[^&]*)*$/.test(trimmed)
  ) {
    try {
      const obj: Record<string, string> = {};
      new URLSearchParams(trimmed).forEach((v, k) => {
        obj[k] = v;
      });
      if (Object.keys(obj).length) return obj;
    } catch {
      /* fall through */
    }
  }
  return trimmed.length > MAX_BODY_CHARS
    ? trimmed.slice(0, MAX_BODY_CHARS) + '…[truncated]'
    : trimmed;
}

function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Arm submission capture on `tabId`. Returns a handle whose `.captured` fills as
 * writes are intercepted-and-neutralized, and whose `.stop()` disarms. Safe to
 * run on the explore tab (reuses the session's existing debugger attachment).
 */
export async function armSubmissionCapture(
  tabId: number,
  opts: { mode?: 'abort' | 'fulfill' } = {},
): Promise<SubmissionCaptureHandle> {
  const target: DebugTarget = { tabId };
  const mode = opts.mode === 'fulfill' ? 'fulfill' : 'abort';
  const captured: CapturedSubmission[] = [];

  let didAttach = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    didAttach = true;
  } catch (e) {
    // Already attached (typically the explore session's network recorder owns
    // it). Enable Fetch on the shared session; leave teardown to the owner.
    warn('submission-capture', `attach failed (already attached?) tabId=${tabId}`, e);
  }
  try {
    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [
        { resourceType: 'XHR', requestStage: 'Request' },
        { resourceType: 'Fetch', requestStage: 'Request' },
        { resourceType: 'Document', requestStage: 'Request' },
      ],
    });
  } catch (e) {
    // enable failed AFTER we attached (tab closed/navigated in the race) — don't
    // leak the just-acquired attachment (stuck "being debugged" banner + blocks
    // future attaches to this tab). Detach only what WE attached, then rethrow.
    // See §10.30.
    if (didAttach) await chrome.debugger.detach(target).catch(() => {});
    throw e;
  }

  const handler = async (source: DebugTarget, method: string, params?: unknown): Promise<void> => {
    if (source.tabId !== tabId || method !== 'Fetch.requestPaused') return;
    const p = params as {
      requestId: string;
      request: {
        url: string;
        method: string;
        headers?: Record<string, string>;
        postData?: string;
        hasPostData?: boolean;
      };
      resourceType?: string;
    };
    const requestId = p.requestId;
    try {
      // Get the body (needed both to classify GraphQL and to record). postData is
      // inlined for small bodies; larger ones need an explicit fetch.
      let bodyText = p.request.postData;
      if (bodyText === undefined && p.request.hasPostData) {
        try {
          const r = (await chrome.debugger.sendCommand(target, 'Fetch.getRequestPostData', {
            requestId,
          })) as { postData?: string };
          bodyText = r.postData;
        } catch {
          /* body unavailable (binary / evicted) */
        }
      }
      const { isWrite, graphql } = classifySubmission(p.request.method, bodyText);
      if (!isWrite) {
        await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId });
        return;
      }
      // WRITE → capture the structure, then neutralize so it never reaches the
      // server.
      const headers = p.request.headers ?? {};
      const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
      captured.push({
        method: p.request.method.toUpperCase(),
        url: p.request.url,
        endpoint: endpointOf(p.request.url),
        resourceType: p.resourceType,
        headers: redactHeaders(headers),
        body: parseBodyForRecord(bodyText, contentType),
        graphql,
        neutralized: mode,
        ts: Date.now(),
      });
      log(
        'submission-capture',
        `captured ${p.request.method} ${endpointOf(p.request.url)} → neutralized(${mode})`,
      );
      if (mode === 'fulfill') {
        await chrome.debugger.sendCommand(target, 'Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: btoa(JSON.stringify({ ok: true, __captured: true })),
        });
      } else {
        await chrome.debugger.sendCommand(target, 'Fetch.failRequest', {
          requestId,
          errorReason: 'Aborted',
        });
      }
    } catch (e) {
      // Never leave a request hanging (that would stall the page). On any error,
      // best-effort continue it — worst case a write lands, but that's strictly
      // better than a frozen tab, and is surfaced by the missing capture.
      warn('submission-capture', 'handler error; continuing request', e);
      try {
        await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId });
      } catch {
        /* request already gone */
      }
    }
  };

  chrome.debugger.onEvent.addListener(handler);
  log('submission-capture', `armed tabId=${tabId} mode=${mode} didAttach=${didAttach}`);

  return {
    captured,
    async stop(): Promise<CapturedSubmission[]> {
      chrome.debugger.onEvent.removeListener(handler);
      try {
        await chrome.debugger.sendCommand(target, 'Fetch.disable', {});
      } catch {
        /* tab may be gone */
      }
      if (didAttach) {
        try {
          await chrome.debugger.detach(target);
        } catch {
          /* already detached / tab closed */
        }
      }
      log('submission-capture', `disarmed tabId=${tabId} captured=${captured.length}`);
      return captured;
    },
  };
}
