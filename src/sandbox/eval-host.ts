/**
 * Sandbox eval host — runs INSIDE the MV3 sandboxed iframe (sandbox.html).
 *
 * The sandbox page has an opaque origin and NO access to `chrome.*`; its only
 * link to the rest of the extension is `postMessage` with the parent window
 * (the SidePanel, which embeds this page as a hidden iframe). Its job is the
 * one thing the rest of the extension can't do under MV3 CSP: `eval` a piece
 * of untrusted adapter source to capture its `cli({...})` registration.
 *
 * Protocol (parent ⇄ sandbox), all messages tagged `__webchat_sandbox`:
 *   parent → sandbox: { type:'EVAL_ADAPTER', id, src }
 *   sandbox → parent: { type:'EVAL_RESULT',  id, ok, defs?, error? }
 *
 * The heavy lifting (strip module syntax, eval, capture) lives in eval-core.ts
 * so it can be unit-tested in node. This file is just the message wiring.
 */

import { evalAdapterSource } from './eval-core';

const TAG = '__webchat_sandbox';

interface EvalRequest {
  [TAG]: true;
  type: 'EVAL_ADAPTER';
  id: string;
  src: string;
}

function isEvalRequest(d: unknown): d is EvalRequest {
  return (
    !!d &&
    typeof d === 'object' &&
    (d as Record<string, unknown>)[TAG] === true &&
    (d as Record<string, unknown>).type === 'EVAL_ADAPTER' &&
    typeof (d as Record<string, unknown>).id === 'string' &&
    typeof (d as Record<string, unknown>).src === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!isEvalRequest(data)) return;

  let reply: Record<string, unknown>;
  try {
    const r = evalAdapterSource(data.src);
    reply = { [TAG]: true, type: 'EVAL_RESULT', id: data.id, ok: r.ok, defs: r.defs, error: r.error };
  } catch (e) {
    // evalAdapterSource is designed not to throw, but never let the sandbox die
    // silently — always answer so the parent's pending promise resolves.
    reply = {
      [TAG]: true,
      type: 'EVAL_RESULT',
      id: data.id,
      ok: false,
      defs: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Reply to whoever asked. Target origin '*' is acceptable: the sandbox holds
  // no secrets, and the parent authenticates replies by checking event.source
  // against its own iframe.contentWindow.
  const source = event.source as Window | null;
  source?.postMessage(reply, '*');
});

// Announce readiness so the parent can await the iframe being live before
// sending the first EVAL_ADAPTER (avoids a race on first install).
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ [TAG]: true, type: 'SANDBOX_READY' }, '*');
}
