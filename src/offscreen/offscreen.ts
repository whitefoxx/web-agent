/**
 * Offscreen document — the panel-free eval venue (T7 ephemeral adapters).
 *
 * The MV3 service worker can't `eval` (CSP) and can't host a DOM, so adapter
 * source has to be eval'd inside a sandboxed iframe living in *some* document.
 * Until now that document was the SidePanel — which meant eval (install / explore
 * / ephemeral load) only worked while the panel was open. An offscreen document
 * is a hidden, DOM-capable extension page the SW can spin up on demand, so it can
 * host the same sandbox iframe with no UI open.
 *
 * This script is tiny on purpose: it just relays `OFFSCREEN_EVAL_ADAPTER`
 * chrome.runtime messages from the SW to the sandbox iframe (reusing the exact
 * same `evalAdapterInSandbox` host the panel uses) and sends the captured defs
 * back via sendResponse. The actual `eval` stays inside the opaque sandbox frame.
 */

import { evalAdapterInSandbox } from '../sidepanel/sandbox-host';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg as { type?: string }).type !== 'OFFSCREEN_EVAL_ADAPTER') return undefined;
  const src = String((msg as { src?: unknown }).src ?? '');
  evalAdapterInSandbox(src).then(
    (r) => sendResponse(r),
    (e) => sendResponse({ ok: false, defs: [], error: e instanceof Error ? e.message : String(e) }),
  );
  return true; // async sendResponse
});
