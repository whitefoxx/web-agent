/**
 * SidePanel-side host for the adapter eval sandbox.
 *
 * The service worker can't eval under MV3 CSP, and a sandboxed page can't be
 * embedded by the SW (no DOM). The SidePanel HAS a DOM and is where the user
 * triggers installs, so it hosts a hidden `<iframe src=sandbox.html>` (the
 * MV3 sandboxed page from vite.config.ts's sandboxPagePlugin). This module is
 * the typed bridge: send adapter source in, get captured serializable defs
 * back, then the caller forwards them to the SW for persist+register.
 *
 * Protocol (mirrors src/sandbox/eval-host.ts), tag `__web_sandbox`:
 *   host → sandbox: { type:'EVAL_ADAPTER', id, src }
 *   sandbox → host: { type:'EVAL_RESULT',  id, ok, defs?, error? }
 *   sandbox → host: { type:'SANDBOX_READY' }   (on load)
 */

const TAG = '__web_sandbox';
const SANDBOX_URL = 'sandbox.html'; // dist root; a web_accessible_resource
const EVAL_TIMEOUT_MS = 10_000;

/** Captured def shape (mirror of sandbox CapturedAdapter / message
 * InstalledAdapterDef). Kept local to avoid a cross-context import. */
export interface CapturedAdapter {
  site: string;
  name: string;
  access?: 'read' | 'write';
  description?: string;
  domain?: string;
  strategy?: string;
  args?: unknown[];
  columns?: string[];
  pipeline?: unknown[];
  navigateBefore?: unknown;
  siteSession?: string;
  kind: 'pipeline' | 'func' | 'unknown';
  hasFunc: boolean;
}

export interface SandboxEvalResult {
  ok: boolean;
  defs: CapturedAdapter[];
  error?: string;
}

let iframe: HTMLIFrameElement | null = null;
let readyPromise: Promise<void> | null = null;
let seq = 0;
const pending = new Map<
  string,
  { resolve: (r: SandboxEvalResult) => void; timer: ReturnType<typeof setTimeout> }
>();

function onMessage(event: MessageEvent): void {
  const d = event.data as Record<string, unknown> | null;
  if (!d || d[TAG] !== true) return;
  if (d.type === 'EVAL_RESULT' && typeof d.id === 'string') {
    const entry = pending.get(d.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(d.id);
    entry.resolve({
      ok: d.ok === true,
      defs: Array.isArray(d.defs) ? (d.defs as CapturedAdapter[]) : [],
      error: typeof d.error === 'string' ? d.error : undefined,
    });
  }
}

/** Lazily create the hidden sandbox iframe and resolve once it's ready. */
function ensureSandbox(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise<void>((resolve, reject) => {
    try {
      window.addEventListener('message', onMessage);
      const el = document.createElement('iframe');
      // §10.17: sandbox the iframe at the ELEMENT level, not only via the
      // manifest `sandbox.pages` of the loaded page. A plain iframe element that
      // loads a page which only BECOMES sandboxed (opaque origin) on commit makes
      // Chromium log "Unsafe attempt to load URL …/sandbox.html from frame …/
      // sandbox.html. Domains, protocols and ports must match." during that
      // plain→sandboxed origin transition. Declaring the sandbox up front means
      // there's no transition to flag. `allow-scripts` is all we need: the inline
      // script runs, and `new Function` eval is gated by the page's sandbox-CSP
      // `unsafe-eval` (a CSP directive, unaffected by sandbox flags), not by this
      // attribute. We deliberately OMIT `allow-same-origin` so the frame stays
      // opaque — matching sandbox.pages — and postMessage already targets '*'.
      el.setAttribute('sandbox', 'allow-scripts');
      el.src = chrome.runtime.getURL(SANDBOX_URL);
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');

      // Resolve on SANDBOX_READY, but also fall back to iframe.onload + a tick
      // in case the READY message races ahead of our listener.
      const readyListener = (event: MessageEvent) => {
        const d = event.data as Record<string, unknown> | null;
        if (d && d[TAG] === true && d.type === 'SANDBOX_READY') {
          window.removeEventListener('message', readyListener);
          resolve();
        }
      };
      window.addEventListener('message', readyListener);
      el.onload = () => {
        // Give the inlined script a tick to register its listener / fire READY.
        setTimeout(resolve, 50);
      };
      el.onerror = () => reject(new Error('sandbox iframe failed to load'));

      document.body.appendChild(el);
      iframe = el;
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  return readyPromise;
}

/**
 * Eval an opencli adapter source string inside the sandbox and return the
 * captured definitions. Never rejects for adapter-level errors (those come
 * back as `{ ok:false, error }`); only rejects if the sandbox itself is
 * unreachable.
 */
export async function evalAdapterInSandbox(src: string): Promise<SandboxEvalResult> {
  await ensureSandbox();
  const win = iframe?.contentWindow;
  if (!win) return { ok: false, defs: [], error: 'sandbox not available' };
  const id = `e${++seq}`;
  return new Promise<SandboxEvalResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, defs: [], error: `sandbox eval timed out after ${EVAL_TIMEOUT_MS}ms` });
    }, EVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    win.postMessage({ [TAG]: true, type: 'EVAL_ADAPTER', id, src }, '*');
  });
}
