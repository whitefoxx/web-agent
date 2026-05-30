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

import { makeLocalPage, runAdapterInPage } from './run-in-page';
import {
  PORT_NAME,
  type InitMsg,
  type RpcReqMsg,
  type RpcReplyMsg,
  type ServerToRunner,
} from './protocol';

(() => {
  // Always leave a forensic breadcrumb: BEFORE checking chrome.runtime, stamp
  // the window with a load marker + a status string. So if the runner gets
  // injected but chrome.runtime.connect isn't available (messaging:false in
  // configureWorld, or a Chrome version issue), the SW can detect that via
  // PageShim.evaluate('window.__webchatRunner') rather than seeing "60s
  // timeout, no port" with zero diagnostics.
  try {
    (globalThis as { __webchatRunner?: unknown }).__webchatRunner = {
      loadedAt: Date.now(),
      status: 'loaded',
      portName: PORT_NAME,
    };
  } catch {
    /* hostile global; ignore */
  }
  const rt = (globalThis as { chrome?: { runtime?: typeof chrome.runtime } }).chrome?.runtime;
  if (!rt || typeof rt.connect !== 'function') {
    // Can't report via port — leave a marker in the page state instead.
    try {
      (globalThis as { __webchatRunner?: unknown }).__webchatRunner = {
        loadedAt: Date.now(),
        status: 'no-chrome-runtime',
        portName: PORT_NAME,
      };
    } catch {
      /* ignore */
    }
    return;
  }
  let port: chrome.runtime.Port;
  try {
    port = rt.connect({ name: PORT_NAME });
  } catch (e) {
    try {
      (globalThis as { __webchatRunner?: unknown }).__webchatRunner = {
        loadedAt: Date.now(),
        status: 'connect-threw',
        portName: PORT_NAME,
        error: String(e),
      };
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    (globalThis as { __webchatRunner?: unknown }).__webchatRunner = {
      loadedAt: Date.now(),
      status: 'connected',
      portName: PORT_NAME,
    };
  } catch {
    /* ignore */
  }

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
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
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
