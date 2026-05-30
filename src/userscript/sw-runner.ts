/**
 * SW-side orchestrator for the userScripts-world adapter runner.
 *
 * Owns three things:
 *   1. One-time `chrome.userScripts.configureWorld` on SW boot, setting a
 *      relaxed CSP so the runner's `Function(...)` adapter eval is allowed.
 *   2. `runInstalledFuncAdapter` — the dispatcher entry point. Opens (or
 *      reuses) a tab + PageShim, injects the runner bundle, exchanges
 *      messages over a port until DONE — handling the navigate-then-reinject
 *      loop the goto trampoline emits.
 *   3. `chrome.runtime.onConnect` filter for the runner port name. The
 *      session for a tab is kept in a Map keyed by tabId so the SW knows
 *      where to route each connecting port (one runner per tab at a time).
 *
 * goto handling: the runner's makeLocalPage RPCs `goto(url)` then throws
 * NAVIGATE_RESTART. We don't actually call PageShim.goto on the RPC path —
 * doing so would destroy the runner's port mid-RPC (race city). Instead, the
 * goto RPC replies OK immediately (no-op), and the NAVIGATE_RESTART message
 * is what drives the actual `chrome.tabs.update + wait + execute`. Same end
 * state, no race.
 *
 * Untestable in node (chrome.userScripts / runtime.onConnect / tabs.update
 * aren't mockable without massive scaffolding). The core eval + page logic
 * IS unit-tested in run-in-page.test.ts; this module is the wiring layer
 * verified in real Chrome.
 */

import { log, warn, error as logError } from '../runtime/log';
import type { PageShim } from '../runtime/page';
import { fulfillRpc, type PageLike as RpcPageLike } from './rpc-server';
import {
  PORT_NAME,
  WORLD_ID,
  type InitMsg,
  type RpcReqMsg,
  type RpcReplyMsg,
  type RunnerToServer,
} from './protocol';

/* ───────── configureWorld ───────── */

let configurePromise: Promise<boolean> | null = null;

/** Call once on SW boot. Sets up the named USER_SCRIPT world used by every
 * runner injection. Idempotent (the API itself is, by design). Returns false
 * if the API isn't available (Chrome < 138) OR the user hasn't enabled the
 * per-extension "Allow user scripts" toggle yet — both surface as a clear
 * error from `execute` later. */
export function configureWebchatWorld(): Promise<boolean> {
  if (configurePromise) return configurePromise;
  configurePromise = (async () => {
    const c = (globalThis as { chrome?: { userScripts?: typeof chrome.userScripts } }).chrome;
    const us = c?.userScripts;
    if (!us || typeof us.configureWorld !== 'function') {
      warn('userscript', 'chrome.userScripts not available — Phase B func adapters disabled');
      return false;
    }
    try {
      await us.configureWorld({
        worldId: WORLD_ID,
        // Adapter source contains `cli({ ..., func: async (page, kwargs) => ... })`.
        // We eval it via new Function(...) inside the runner to recover the
        // closure — needs unsafe-eval in the world's CSP.
        csp: "script-src 'self' 'unsafe-eval'; object-src 'self'",
        messaging: true,
      });
      log('userscript', `configureWorld ok (worldId=${WORLD_ID})`);
      return true;
    } catch (e) {
      // Most likely: user hasn't enabled "Allow user scripts" in
      // chrome://extensions for this extension. Surface but don't throw —
      // dispatcher will give a clear error on first call attempt.
      warn(
        'userscript',
        'configureWorld failed (likely "Allow user scripts" toggle off in chrome://extensions)',
        e,
      );
      return false;
    }
  })();
  return configurePromise;
}

/** Is the userScripts API even present? Cheap synchronous check used by
 * install-manager to decide whether func adapters are runnable. Defensive
 * against `chrome` being globally undeclared (node tests): a bare `chrome`
 * reference would ReferenceError; reading via globalThis is safe. */
export function isUserScriptsApiAvailable(): boolean {
  const c = (globalThis as { chrome?: { userScripts?: { configureWorld?: unknown } } }).chrome;
  return !!c?.userScripts && typeof c.userScripts.configureWorld === 'function';
}

/* ───────── per-session port routing ───────── */

interface Session {
  tabId: number;
  page: PageLike;
  init: InitMsg;
  /** Pending navigate URL captured by the goto RPC reply, drained when we
   * receive NAVIGATE_RESTART. (Belt-and-suspenders: NAVIGATE_RESTART carries
   * the URL too; this map is just for crash-resilience.) */
  pendingNavigate?: string;
  /** Settle on DONE / hard error / port-died-without-DONE. */
  resolve: (v: { ok: true; value: unknown } | { ok: false; error: string }) => void;
  /** "navigating" path takes over: orchestrator awaits this and re-executes. */
  resolveNavigate: (url: string) => void;
}

/** Anything with the methods RPC server uses; PageShim qualifies via structural
 * compat (this file doesn't need the full PageShim surface). */
type PageLike = RpcPageLike;

/** One runner per tab at a time. The dispatcher serialises calls per tab via
 * `humanPaceForSite`, but the per-tab map is the actual guard against two
 * adapters trying to share a runner port. */
const sessionsByTab = new Map<number, Session>();

/** Registered once on SW boot (see service-worker.ts). Routes any incoming
 * port with our name to the right session by tab. */
export function handleRunnerPortConnect(port: chrome.runtime.Port): void {
  // Always log every onConnect so missing the runner port shows up clearly
  // ("expected webchat-userscript-runner, got X" — vs nothing at all).
  log('userscript', `onConnect port.name=${port.name}`, {
    senderTabId: port.sender?.tab?.id,
    senderUrl: port.sender?.url,
  });
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') {
    warn('userscript', 'runner port has no sender.tab.id — dropping');
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    return;
  }
  const session = sessionsByTab.get(tabId);
  if (!session) {
    warn('userscript', `runner port arrived for tabId=${tabId} with no active session — dropping`, {
      knownSessions: [...sessionsByTab.keys()],
    });
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    return;
  }
  log('userscript', `runner port connected tabId=${tabId} — sending INIT`);

  port.onMessage.addListener(async (msg: RunnerToServer) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'READY') {
      port.postMessage(session.init);
      return;
    }
    if (msg.type === 'RPC_REQ') {
      const reply = await handleRpcReq(msg, session);
      port.postMessage(reply);
      return;
    }
    if (msg.type === 'NAVIGATE_RESTART') {
      log('userscript', `runner requested navigate to ${msg.url} (tabId=${tabId})`);
      session.resolveNavigate(msg.url);
      return;
    }
    if (msg.type === 'DONE') {
      log('userscript', `runner DONE tabId=${tabId} status=${msg.status}`);
      if (msg.status === 'ok') {
        session.resolve({ ok: true, value: msg.value });
      } else {
        session.resolve({ ok: false, error: msg.error ?? 'runner reported error' });
      }
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    log('userscript', `runner port disconnected tabId=${tabId}`);
    // If the port dies before DONE, it's almost always a navigation — the
    // orchestrator's `Promise.race` against resolveNavigate handles that. We
    // don't synthesise an error here because that races with legitimate
    // post-DONE disconnects.
  });
}

/** Read the runner's load marker from the page (best-effort) so the SW can
 * tell post-mortem what stage the runner reached. The runner stamps DOM
 * attributes (NOT globals) precisely so PageShim.evaluate (which targets
 * MAIN world via CDP) can see them across the USER_SCRIPT/MAIN world barrier.
 * Catches everything — a detach/attach race or non-scriptable page shouldn't
 * break the surrounding timeout-handler. */
async function diagnose(
  page: PageLike,
  tabId: number,
): Promise<{ status: unknown; at: unknown; extra: unknown; readErr?: string }> {
  const ev = (page as unknown as { evaluate?: (s: string) => Promise<unknown> }).evaluate;
  if (typeof ev !== 'function') {
    return { status: '(page.evaluate unavailable)', at: null, extra: null };
  }
  try {
    const raw = await ev.call(
      page,
      `JSON.stringify({
        status: document.documentElement?.getAttribute('data-webchat-runner') ?? null,
        at: document.documentElement?.getAttribute('data-webchat-runner-at') ?? null,
        extra: document.documentElement?.getAttribute('data-webchat-runner-extra') ?? null,
      })`,
    );
    if (typeof raw !== 'string') return { status: '(non-string eval result)', at: null, extra: null };
    return JSON.parse(raw);
  } catch (e) {
    return {
      status: null,
      at: null,
      extra: null,
      readErr: `eval failed on tab=${tabId}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function handleRpcReq(req: RpcReqMsg, session: Session): Promise<RpcReplyMsg> {
  // goto is special: ack here without navigating (see file header). The
  // runner's follow-up NAVIGATE_RESTART is what triggers the real navigate.
  if (req.method === 'goto') {
    session.pendingNavigate = req.url ?? '';
    return { type: 'RPC_REPLY', rpcId: req.rpcId, ok: true, value: undefined };
  }
  const r = await fulfillRpc(session.page, {
    method: req.method,
    url: req.url,
    args: req.args,
    tabId: session.tabId,
  });
  return { type: 'RPC_REPLY', rpcId: req.rpcId, ok: r.ok, value: r.value, error: r.error };
}

/* ───────── orchestrator ───────── */

export interface RunInstalledFuncArgs {
  /** Tab the adapter should run in. Caller (dispatcher) owns its lifecycle. */
  tabId: number;
  /** PageShim attached to that tab — used to fulfill chrome.* and CDP RPCs. */
  page: PageShim;
  /** Verbatim adapter source the user installed (stored alongside the def in
   * IDB; passed through here). */
  source: string;
  /** Which command to invoke from the source's cli() registrations. */
  site: string;
  name: string;
  /** Caller-supplied args (`kwargs` in opencli). */
  kwargs: Record<string, unknown>;
  /** Cap on how many `goto` reinjects we'll loop through before giving up.
   * One adapter call → at most this many (page navigate + re-exec) cycles. */
  maxReinjects?: number;
  /** Hard cap on a single execution before forcibly resolving with timeout. */
  timeoutMs?: number;
}

/** Top-level entry point. Loops navigate-then-reinject until the adapter
 * finishes or hits the limits. Always cleans the per-tab session entry. */
export async function runInstalledFuncAdapter(
  args: RunInstalledFuncArgs,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  log('userscript', `runInstalledFuncAdapter start tab=${args.tabId} ${args.site}/${args.name}`, {
    kwargs: args.kwargs,
  });
  const apiAvail = isUserScriptsApiAvailable();
  if (!apiAvail) {
    warn('userscript', 'API not available — bail');
    return {
      ok: false,
      error:
        'Phase B func adapter requires chrome.userScripts (Chrome 138+ with "Allow user scripts" enabled in chrome://extensions).',
    };
  }
  const worldOk = await configureWebchatWorld();
  if (!worldOk) {
    warn('userscript', 'configureWorld returned false — bail');
    return {
      ok: false,
      error:
        'chrome.userScripts.configureWorld failed — please enable "Allow user scripts" for this extension at chrome://extensions and retry.',
    };
  }
  log('userscript', `world ready, proceeding to inject runner into tab=${args.tabId}`);

  const maxReinjects = args.maxReinjects ?? 3;
  const timeoutMs = args.timeoutMs ?? 60_000;

  // Each loop iteration = one execute() + one runner lifecycle.
  for (let i = 0; i <= maxReinjects; i++) {
    const outcome = await runOnceWithPort({
      tabId: args.tabId,
      page: args.page,
      init: {
        type: 'INIT',
        source: args.source,
        site: args.site,
        name: args.name,
        kwargs: args.kwargs,
        tabId: args.tabId,
      },
      timeoutMs,
    });

    if (outcome.kind === 'done') {
      return outcome.ok
        ? { ok: true, value: outcome.value }
        : { ok: false, error: outcome.error ?? 'runner finished without a result' };
    }
    if (outcome.kind === 'navigate') {
      // Drive the navigate via PageShim so we reuse its load-wait logic.
      const url = outcome.url ?? '';
      if (!url) return { ok: false, error: 'navigate signal carried no URL' };
      log('userscript', `navigating tab=${args.tabId} → ${url} (iter ${i + 1}/${maxReinjects + 1})`);
      try {
        await args.page.goto(url);
      } catch (e) {
        return { ok: false, error: `navigate failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      // Loop continues → next iteration re-executes the runner script.
    }
  }
  return { ok: false, error: `adapter exceeded ${maxReinjects} navigate-reinject cycles` };
}

interface RunOnceResult {
  kind: 'done' | 'navigate';
  ok?: boolean;
  value?: unknown;
  error?: string;
  url?: string;
}

async function runOnceWithPort(args: {
  tabId: number;
  page: PageLike;
  init: InitMsg;
  timeoutMs: number;
}): Promise<RunOnceResult> {
  // Drop any stale session before recording a new one (shouldn't happen
  // since the orchestrator is the only writer, but defends against a leaked
  // entry from a prior crash).
  sessionsByTab.delete(args.tabId);

  return await new Promise<RunOnceResult>((resolveOuter) => {
    const settle = (out: RunOnceResult): void => {
      if (sessionsByTab.get(args.tabId) === session) sessionsByTab.delete(args.tabId);
      clearTimeout(timer);
      resolveOuter(out);
    };
    const session: Session = {
      tabId: args.tabId,
      page: args.page,
      init: args.init,
      resolve: (r) => {
        if (r.ok) settle({ kind: 'done', ok: true, value: r.value });
        else settle({ kind: 'done', ok: false, error: r.error });
      },
      resolveNavigate: (url) => settle({ kind: 'navigate', url }),
    };
    sessionsByTab.set(args.tabId, session);

    const timer = setTimeout(() => {
      // Read the runner's DOM-attribute marker for a post-mortem hint, THEN
      // settle. Awaiting is important: settle drops the session and the
      // dispatcher's `finally` detaches the PageShim. If diagnose runs after
      // detach, the shim's auto-reattach can collide with the next call's
      // own attach → "Another debugger is already attached to the tab".
      // Small (~50ms) latency vs. settling immediately, but worth it for
      // reliable diagnostics + no follow-on attach race.
      void (async () => {
        let diag: Awaited<ReturnType<typeof diagnose>>;
        try {
          diag = await diagnose(args.page, args.tabId);
        } catch (e) {
          diag = { status: null, at: null, extra: null, readErr: e instanceof Error ? e.message : String(e) };
        }
        warn('userscript', `runner timed out after ${args.timeoutMs}ms — diag`, diag);
        settle({
          kind: 'done',
          ok: false,
          error: `runner timed out after ${args.timeoutMs}ms (check SW console for "runner timed out … diag" line)`,
        });
      })();
    }, args.timeoutMs);

    // Fire the inject. If execute fails (no "Allow user scripts", etc),
    // surface the error synchronously. Log start AND result with the full
    // InjectionResult[] so per-frame load errors surface (each result has
    // .error if the script faulted in that frame).
    const us = chrome.userScripts;
    log('userscript', `chrome.userScripts.execute starting tab=${args.tabId}`);
    us
      .execute({
        target: { tabId: args.tabId },
        world: 'USER_SCRIPT',
        worldId: WORLD_ID,
        injectImmediately: true,
        js: [{ file: 'userscript-runner.js' }],
      })
      .then((results: chrome.userScripts.InjectionResult[] | undefined) => {
        // Inline the result summary into the log STRING (not the {data} arg) so
        // the Chrome console shows it without needing a manual ▶ expand — and
        // so it survives string-based grep / paste-into-issue.
        const n = results?.length ?? 0;
        const summary = (results ?? [])
          .map(
            (r) =>
              `frame=${r.frameId}` +
              (r.error ? ` ERROR=${JSON.stringify(r.error.message)}` : ' ok'),
          )
          .join('; ');
        log(
          'userscript',
          `chrome.userScripts.execute resolved tab=${args.tabId} frames=${n} [${summary || '(no frames returned)'}]`,
        );
      })
      .catch((e: unknown) => {
        logError('userscript', 'execute REJECTED', e);
        settle({
          kind: 'done',
          ok: false,
          error: `chrome.userScripts.execute failed: ${e instanceof Error ? e.message : String(e)}. Most likely "Allow user scripts" is off for this extension.`,
        });
      });
  });
}
