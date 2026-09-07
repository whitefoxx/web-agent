/**
 * Service worker — extension entry point. Boots the runtime and registers every
 * chrome.* listener; all the actual work lives in focused sibling modules so this
 * file stays a readable "wiring diagram".
 *
 * Module map:
 *   - runtime-state.ts   — keep-alive self-ping (+ session probe) + sendToSidepanel.
 *   - active-sessions.ts — the engine's activeSessions registry (full-shell only).
 *   - message-router.ts  — the onMessage switch (everything the panel can ask for).
 *   - engine-driver.ts   — USER_MESSAGE → one api-engine run + write/H9 gates + cleanup.
 *   - explore-driver.ts  — Explore v2 (record → synthesize → verify) + verify-run / import.
 *   - confirm-prompts.ts — write-confirm / human-takeover / plan-decision prompts.
 *   - adapter-handlers.ts, session-handlers.ts, notifications.ts, orch-events.ts.
 *
 * Responsibilities kept here:
 *   - Open the side panel on toolbar action click.
 *   - Register all chrome.* listeners (onMessage → routeMessage, onConnect
 *     keep-alive port, onUserScriptConnect, alarms, notifications click).
 *   - Boot-time: recover interrupted sessions, register runtime-installed
 *     adapters into the live registry, configure the USER_SCRIPT-world, connect
 *     the external-control bridge, re-sync schedule alarms.
 *
 * History: an earlier "connector" mode hijacked a logged-in DeepSeek tab for
 * inference. That path required tab tracking (onRemoved/onUpdated), pause/
 * resume on tab loss, INJECT_PROMPT/CHATBOT_RESPONSE plumbing, etc. — all
 * removed when the only-mode-now (api) doesn't need any chatbot tab. Tool
 * execution still uses chrome.tabs/debugger to drive arbitrary target sites
 * via the adapter dispatcher, but that's site-agnostic and lives elsewhere.
 */

import { log, warn } from '@base/runtime/log';
import { listSessions, saveSession } from '../agent/session';
import { loadInstalledOnBoot } from '../adapters/install-manager';
import { setBrokenNotifier } from '../adapters/adapter-health-store';
import { initBridge, refreshBridgeCatalog, setBridgeBusyHooks } from './bridge-client';
import { syncAllAlarms, handleScheduleAlarm } from './schedule-runner';
import { configureWebWorld, handleRunnerPortConnect } from '../userscript/sw-runner';
import { syncSiteScriptsOnBoot } from '@base/site-scripts/register';
import { reapLeakedAgentWindowsOnBoot } from '@base/background/agent-window';
import { initPageLlmBridge } from './page-llm';
import { activeSessions } from './active-sessions';
import {
  keepaliveConnections,
  sendToSidepanel,
  onBridgeBusy,
  onBridgeIdle,
  setActiveSessionProbe,
} from '@base/background/runtime-state';
import { broadcastAdapterBroken } from './adapter-handlers';
import { routeMessage } from './message-router';
import { handleExternalConnect } from './external-mcp';
import type { SessionDoneEvt } from '../messages';

// Side-effect import: registers site-independent web-operation adapters
// (open_url, get_page_text, screenshot, scroll, click, type, …) which the
// agent uses to navigate / scrape arbitrary pages without a site adapter.
// Per-site adapters (xiaohongshu, twitter, …) are installed from the
// marketplace at runtime — no built-in site directories.
import '../tools/generic/_all';

// Explore seam: the standalone perception tools (open_url / get_html /
// query_dom / …) reach the active explore session through `core/explore-gate`
// so they don't statically import the heavy explore subsystem (that's what lets
// the lite bridge shell reuse them). The FULL shell wires the real getter here;
// the lite SW never does, so those tools take their normal tab_id path there.
import { setExploreGate } from '@base/core/explore-gate';
import { getActiveExploreSession } from '../explore/session';

const SCOPE = 'sw';

// Wire the explore gate to the real session getter BEFORE any tool can run
// (registration above is synchronous; message handling starts later).
setExploreGate(getActiveExploreSession);

// Keep-alive session probe (P4): runtime-state (base) can't import the full-only
// activeSessions map, so the full SW teaches its idle check what "a session is
// running" means. The lean shells never wire it → the ping tracks bridge calls
// alone (they have no engine sessions).
setActiveSessionProbe(() => activeSessions.size > 0);

// Bridge busy/idle → keep-alive ping (F-8): a bridge call doesn't populate
// activeSessions, so wire its hooks into the shared keep-alive in runtime-state.
setBridgeBusyHooks({ onBusy: onBridgeBusy, onIdle: onBridgeIdle });

/* ───────── lifecycle ───────── */

log(SCOPE, 'service worker booting');
void recoverInterruptedSessionsOnBoot();
// Restore runtime-installed adapters into the live registry. Fire-and-forget:
// boot shouldn't block on IDB, and a brand-new install has nothing to restore.
// F-2: once the installed adapters are in the registry, re-push the bridge
// catalog. The bridge WS often connects + receives the generic-only catalog
// BEFORE this async load finishes, leaving `/tools` stuck at the 30 generics;
// refreshBridgeCatalog re-sends the complete set (no-op if the WS isn't up yet —
// the onopen handler then sends the now-complete catalog).
void loadInstalledOnBoot()
  .then(() => refreshBridgeCatalog())
  .catch((e) => warn(SCOPE, 'loadInstalledOnBoot failed', e));
// Phase B: set up the USER_SCRIPT-world we inject installed func adapters
// into. configureWorld is idempotent; we still call it eagerly so the first
// adapter invocation doesn't pay the cost (and so failures — most likely
// "Allow user scripts" disabled — surface in logs at boot, not on first call).
void configureWebWorld();
// Site scripts (persistent ad-blocking/enhancement): re-project the stored rules onto chrome.userScripts
// on boot. userScripts persist on their own, but this reconciles any IDB↔registry
// drift and is the single place the runtime state is rebuilt from the source of truth.
void syncSiteScriptsOnBoot().catch((e) => warn(SCOPE, 'syncSiteScriptsOnBoot failed', e));
// Collapse leaked duplicate agent windows (the same-named "Web Agent" tab-group
// pile-up) on every SW boot / extension reload — closes stale agent-only windows
// that recovery could no longer re-adopt (e.g. pre-rename "WebChat Agent" groups).
void reapLeakedAgentWindowsOnBoot()
  .then((n) => n && log(SCOPE, `reaped ${n} leaked agent window(s) on boot`))
  .catch((e) => warn(SCOPE, 'reapLeakedAgentWindowsOnBoot failed', e));

chrome.runtime.onInstalled.addListener(() => {
  log(SCOPE, 'onInstalled');
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => warn(SCOPE, 'setPanelBehavior failed', e));
});

chrome.runtime.onStartup.addListener(() => log(SCOPE, 'onStartup'));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'web-keepalive') {
    keepaliveConnections.add(port);
    log(SCOPE, `keepalive port connected (total=${keepaliveConnections.size})`);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume bfcache/disconnect lastError
      keepaliveConnections.delete(port);
      log(SCOPE, `keepalive port disconnected (remaining=${keepaliveConnections.size})`);
    });
    return;
  }
  log(SCOPE, `unexpected onConnect port name=${port.name} — ignored`);
});

// External web apps (manifest `externally_connectable`, e.g. localmd.app on
// localhost:5173) connect here and speak MCP-shaped JSON-RPC — initialize /
// tools/list / tools/call{web_task}. Origin re-verified inside the handler.
if (chrome.runtime.onConnectExternal) {
  chrome.runtime.onConnectExternal.addListener(handleExternalConnect);
}

// USER_SCRIPT-world (Phase B runner) ports come through a SEPARATE event —
// chrome.runtime.onUserScriptConnect — NOT onConnect. The userScripts API
// deliberately isolates user-script messaging so an extension can't
// accidentally cross-talk between its content-script port set and its
// user-script port set. Symptom of getting this wrong: runner connects
// successfully (its DOM marker says status='connected'), but the SW's
// onConnect listener never fires → 60s timeout, "no active session" warn
// never appears either. Use the dedicated event.
if (chrome.runtime.onUserScriptConnect) {
  chrome.runtime.onUserScriptConnect.addListener((port) => {
    handleRunnerPortConnect(port);
  });
} else {
  warn(
    SCOPE,
    'chrome.runtime.onUserScriptConnect not available — Phase B func adapters will not receive port connections',
  );
}

/** On boot, find any persisted session whose status was 'running' at the
 * moment the prior SW instance died and mark it as 'error'. Its in-memory
 * activeSessions entry is gone with the worker, so the engine can't continue
 * from where it left off — the user has to retry the last message. We push
 * SESSION_DONE so the SidePanel clears any stale "generating" banner. */
async function recoverInterruptedSessionsOnBoot(): Promise<void> {
  try {
    const sessions = await listSessions({ status: 'running' });
    for (const s of sessions) {
      // If this boot was triggered by a USER_MESSAGE that's already resuming
      // the session, it's live again — don't mark it errored or pop a spurious
      // "interrupted" banner over an in-flight turn.
      if (activeSessions.has(s.id)) continue;
      log(SCOPE, `recovering interrupted session ${s.id}`);
      s.status = 'error';
      await saveSession(s);
      sendToSidepanel({
        type: 'SESSION_DONE',
        sessionId: s.id,
        reason: 'error',
        recoverable: true, // history is in IDB; keep the binding so "continue" resumes it
        error:
          'The session was interrupted because the extension background was recycled. Send another message to keep chatting (based on the prior context).',
      } satisfies SessionDoneEvt);
    }
  } catch (e) {
    warn(SCOPE, 'recoverInterruptedSessionsOnBoot failed', e);
  }
}

chrome.action.onClicked.addListener((tab) => {
  log(SCOPE, 'action clicked', { tabId: tab.id });
  if (tab.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id }).catch((e) => warn(SCOPE, 'sidePanel.open', e));
  }
});

// T7 P1: connect to the external-control bridge if the user enabled it. Runs on
// every SW start (incl. wake) so the connection re-establishes after a recycle.
void initBridge();

// H3-P1: scheduled tasks — route alarm fires to runs; re-sync alarms on wake.
chrome.alarms?.onAlarm?.addListener((a) => handleScheduleAlarm(a.name));
void syncAllAlarms();

// H11: page↔LLM bridge — site-script js may call the LLM via __webLLM
// (dedicated onUserScriptMessage channel; validated + rate-limited).
initPageLlmBridge();

// H1-P2c: alert the SidePanel when an installed adapter drifts into broken.
setBrokenNotifier((id, lastError) => void broadcastAdapterBroken(id, lastError));

// Central message router — every SidePanel request lands here (see message-router.ts).
chrome.runtime.onMessage.addListener(routeMessage);

// Click a "task done" notification → open the side panel (best-effort; the click
// is a user gesture, and getLastFocused gives the window to open it in).
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('done_')) return;
  void chrome.notifications.clear(id);
  void (async () => {
    try {
      const win = await chrome.windows.getLastFocused();
      if (typeof win.id === 'number') await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      /* best effort — the user can click the toolbar icon */
    }
  })();
});
