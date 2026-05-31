/**
 * USER_SCRIPT-world runner — bundled by Vite into `dist/userscript-runner.js`
 * and injected via `chrome.userScripts.execute`. Pure browser code; no chrome
 * APIs except the limited set exposed to user scripts (chrome.runtime.connect /
 * sendMessage / getURL / id).
 *
 * Lifecycle:
 *   1. As soon as injected, opens a port to the SW (PORT_NAME) and posts READY.
 *   2. Waits for INIT (source, site, name, kwargs, tabId).
 *   3. Builds a `page` via makeLocalPage with a port-based RPC, then calls
 *      runAdapterInPage to eval + invoke the adapter func.
 *   4. Reports DONE (ok/error) — or NAVIGATE_RESTART when the goto trampoline
 *      throws. Closes the port; SW takes it from there.
 *
 * The runner does NOT decide whether to re-inject after a navigate — that's
 * the SW's call. The runner is single-shot per injection.
 *
 * No tests for this file directly: it's a thin glue around already-tested
 * pieces (makeLocalPage + runAdapterInPage from ../userscript/run-in-page).
 * Real verification happens in real Chrome (Phase B B2b acceptance).
 */

import { makeLocalPage, runAdapterInPage, fmtError } from './run-in-page';
import {
  PORT_NAME,
  type InitMsg,
  type RpcReqMsg,
  type RpcReplyMsg,
  type ServerToRunner,
} from './protocol';

(() => {
  // Forensic breadcrumb stamped into the page DOM (NOT into a global variable):
  // USER_SCRIPT world and MAIN world have isolated globalThis bindings, so a
  // global written here is invisible to the SW's PageShim.evaluate (which
  // defaults to MAIN world via CDP Runtime.evaluate). The DOM, however, is
  // shared between worlds — so a `data-*` attribute on documentElement reads
  // back correctly from either world. Status values map to call-stage so the
  // SW's timeout post-mortem tells us exactly where the runner stopped.
  function mark(status: string, extra?: Record<string, unknown>): void {
    try {
      const el = document.documentElement;
      if (!el) return;
      el.setAttribute('data-webchat-runner', status);
      el.setAttribute('data-webchat-runner-at', String(Date.now()));
      if (extra) el.setAttribute('data-webchat-runner-extra', JSON.stringify(extra));
    } catch {
      /* hostile DOM; ignore */
    }
  }
  mark('loaded');
  const rt = (globalThis as { chrome?: { runtime?: typeof chrome.runtime } }).chrome?.runtime;
  if (!rt || typeof rt.connect !== 'function') {
    mark('no-chrome-runtime', {
      hasChrome: !!(globalThis as { chrome?: unknown }).chrome,
      hasRuntime: !!rt,
      hint: 'configureWorld may have missed messaging:true, or this world is not USER_SCRIPT — runner cannot reach the SW.',
    });
    try {
      console.warn('[webchat-runner] chrome.runtime.connect not available — adapter cannot run.');
    } catch {
      /* ignore */
    }
    return;
  }
  let port: chrome.runtime.Port;
  try {
    port = rt.connect({ name: PORT_NAME });
  } catch (e) {
    mark('connect-threw', { error: fmtError(e) });
    try {
      console.warn('[webchat-runner] chrome.runtime.connect threw:', e);
    } catch {
      /* ignore */
    }
    return;
  }
  mark('connected', { portName: PORT_NAME });

  // RPC plumbing: each call gets a monotonically increasing id, and we resolve
  // the matching promise when an RPC_REPLY with that id arrives.
  const pending = new Map<number, (r: RpcReplyMsg) => void>();
  let rpcCounter = 0;

  function sendRpc(method: string, args: Record<string, unknown>): Promise<unknown> {
    const id = ++rpcCounter;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, (reply) => {
        if (reply.ok) resolve(reply.value);
        else reject(new Error(reply.error ?? `RPC ${method} failed`));
      });
      const msg: RpcReqMsg = {
        type: 'RPC_REQ',
        rpcId: id,
        method,
        url: (args as { url?: string }).url,
        // makeLocalPage forwards positional args as `args` for non-goto methods.
        args: (args as { args?: unknown[] }).args,
      };
      port.postMessage(msg);
    });
  }

  async function runWithInit(init: InitMsg): Promise<void> {
    const page = makeLocalPage({
      rpc: (method, args) => sendRpc(method, args as Record<string, unknown>),
      tabId: init.tabId,
      lastNavigatedUrl: init.lastNavigatedUrl,
    });
    const result = await runAdapterInPage({
      source: init.source,
      site: init.site,
      name: init.name,
      kwargs: init.kwargs,
      page,
    });
    if (result.status === 'navigating') {
      port.postMessage({ type: 'NAVIGATE_RESTART', url: result.navigateUrl ?? '' });
    } else if (result.status === 'ok') {
      port.postMessage({ type: 'DONE', status: 'ok', value: result.result });
    } else {
      port.postMessage({ type: 'DONE', status: 'error', error: result.error });
    }
    // Don't disconnect — SW closes the port (or it dies on tab unload).
  }

  port.onMessage.addListener((m: ServerToRunner) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'INIT') {
      // Fire and forget — any errors come back via DONE.
      void runWithInit(m).catch((e) => {
        port.postMessage({
          type: 'DONE',
          status: 'error',
          error: fmtError(e),
        });
      });
    } else if (m.type === 'RPC_REPLY') {
      const handler = pending.get(m.rpcId);
      if (handler) {
        pending.delete(m.rpcId);
        handler(m);
      }
    }
  });

  port.postMessage({ type: 'READY' });
})();
