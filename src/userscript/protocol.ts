/**
 * Wire protocol between the in-tab USER_SCRIPT-world runner and the SW-side
 * orchestrator. Port-based (chrome.runtime.connect with name === PORT_NAME):
 * the runner opens the port, the SW recognises it via the name, finds the
 * pending session for that tab, and exchanges messages until DONE.
 *
 * Why port-based (not chrome.runtime.sendMessage):
 *   - We need TWO-WAY messaging: runner→SW for RPC requests AND SW→runner for
 *     INIT (source, adapter id, args) + RPC replies. Ports give us that on a
 *     single duplex channel; sendMessage/onUserScriptMessage is one-way per
 *     direction with awkward request/reply correlation.
 *   - Port disconnect doubles as a navigate signal — when the tab unloads, the
 *     port dies; the SW knows the runner is gone without a separate heartbeat.
 *
 * Wire shape (must match makeLocalPage / fulfillRpc; the test suite asserts
 * the RPC method sets agree).
 */

/** chrome.runtime.connect name for the runner→SW port. Filtered in SW
 * onConnect so other extension components can't hit this handler by accident. */
export const PORT_NAME = 'webchat-userscript-runner';

/** worldId we configure once on SW boot. One world per extension is fine — we
 * don't host multiple isolated adapter populations. */
export const WORLD_ID = 'webchat-runner';

/* ───────── SW → runner ───────── */

export interface InitMsg {
  type: 'INIT';
  /** Full adapter source — eval'd in-runner to recover the func closure. */
  source: string;
  /** Which (site,name) command to run — a single source can register many. */
  site: string;
  name: string;
  /** The agent's call args (matches opencli's `kwargs`). */
  kwargs: Record<string, unknown>;
  /** Tab id the runner is in (forwarded on RPCs that need it). */
  tabId: number;
  /** URL the SW just navigated to as a result of a NAVIGATE_RESTART from a
   * prior runner instance for THIS adapter run. Undefined on the very first
   * run. When set, the goto trampoline treats `page.goto(thatUrl)` as a no-op
   * on the FIRST call, even if `location.href` doesn't match — because the
   * server may have redirected to a different canonical URL (zhihu:
   * `/answer/<aid>` → `/question/<qid>/answer/<aid>`). Without this hint
   * `sameLogicalPage` returns false on path mismatch and the trampoline
   * loops until maxReinjects. Consume-once: subsequent gotos in the same
   * runner go through the normal trampoline. See adapter-hot-plug.md §10.11. */
  lastNavigatedUrl?: string;
}

export interface RpcReplyMsg {
  type: 'RPC_REPLY';
  rpcId: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type ServerToRunner = InitMsg | RpcReplyMsg;

/* ───────── runner → SW ───────── */

/** The runner sends READY immediately on connect, so the SW knows the port is
 * live and the runner is awaiting INIT. */
export interface ReadyMsg {
  type: 'READY';
}

export interface RpcReqMsg {
  type: 'RPC_REQ';
  rpcId: number;
  method: string;
  /** For goto: target URL. For everything else: positional args from
   * makeLocalPage's `page[method](...args)`. */
  url?: string;
  args?: unknown[];
}

export interface DoneMsg {
  type: 'DONE';
  status: 'ok' | 'error';
  value?: unknown;
  error?: string;
}

/** Runner signalling it needs the SW to navigate the tab + re-inject. After
 * sending this, the runner stops; the SW handles navigation + re-execute. */
export interface NavigateRestartMsg {
  type: 'NAVIGATE_RESTART';
  url: string;
}

export type RunnerToServer = ReadyMsg | RpcReqMsg | DoneMsg | NavigateRestartMsg;
