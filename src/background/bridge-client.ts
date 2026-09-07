/**
 * Extension side of the external-control bridge (roadmap T7 — see
 * docs/external-agent-control.md). The MV3 service worker can't accept inbound
 * connections, so it dials OUT to a local bridge daemon over WebSocket,
 * registers, and answers `call` commands.
 *
 * - P2: pushes its tool catalog (openAiToolsFromRegistry) on connect + on
 *   ADAPTERS_CHANGED; `call` routes through executeAdapter so real READ tools run.
 * - P4: WRITE tools run too (confirmation happens on the AI-editor side — the MCP
 *   client approves each call — so no browser prompt). A `allowWrites` toggle
 *   (default on) is the kill switch. Explore commands (`explore_start` /
 *   `explore_stop`) let the external agent author adapters with the explore tools.
 *
 * Security: localhost-only (the bridge binds 127.0.0.1). Off by default —
 * `enabled` / `port` / `allowWrites` live in chrome.storage.local.
 */

import { openAiToolsFromRegistry, lookupAdapter } from '@base/tools/manifest';
import { createBridge, type ToolResult } from '@base/core/bridge-core';
import { createWsBridge } from '@base/core/ws-bridge';
import { createIdleSweep } from '@base/core/idle-sweep';
import type { BridgeCall } from '../messages';
import { getInstalled } from '../adapters/installed-store';
import { buildAdapterReport } from '../adapters/adapter-report';
import { executeAdapter, reapPoolTabs } from '../tools/dispatcher';
import { ExploreSession, getActiveExploreSession } from '../explore/session';
import { adoptTab } from '@base/background/controlled-tabs';
import { createAgentTab } from '@base/background/agent-window';
import { listShortcuts, saveShortcut, makeShortcutId } from '../shortcuts/store';
import { getMemory, appendMemory, setMemoryContent } from '../agent/memory-store';
import { execNotesAction, NOTES_WRITE_ACTIONS } from '../agent/notes-store';
import { loadProfiles, upsertProfile, setActiveProfile } from '../config/llm-config';
import { loadEphemeralAdapter } from './ephemeral-adapter';
import { parseAwaitUserAction } from '../agent/engine-tools';
import { requestHumanTakeover } from './confirm-prompts';
import { keepaliveConnections } from '@base/background/runtime-state';
import { notifyHumanTakeover } from './notifications';
import {
  buildSiteScript,
  putSiteScript,
  getSiteScript,
  listSiteScripts,
  deleteSiteScript,
  makeSiteScriptId,
  flagFragileSelectors,
} from '@base/site-scripts/store';
import {
  refreshSiteScript,
  unregisterSiteScriptById,
  siteScriptsRunnable,
  previewSiteScript,
} from '@base/site-scripts/register';

const ENABLED_KEY = 'bridgeEnabled';
const PORT_KEY = 'bridgePort';
const ALLOW_WRITES_KEY = 'bridgeAllowWrites';
const DENY_KEY = 'bridgeWriteDenySites';
const DEFAULT_PORT = 8787;

/** Per-inbound-call safety timeout (< the bridge server's own ~320s). Upstream
 * tool calls are already bounded (§10.27); this only fires if one exceeds every
 * bound, replying an error so the external agent isn't left hanging. §10.34.
 * Exported: the web-app Port bridge (external-mcp) applies the same bound. */
export const BRIDGE_CALL_TIMEOUT_MS = 240_000;
let allowWrites = true; // execute write tools? (the AI editor confirms each call)
let denySites: string[] = []; // sites where external WRITES are always blocked (P2b)

// The WebSocket transport (dial / register+catalog / heartbeat / reconnect / the
// call→run→reply loop) lives in src/core/ws-bridge.ts, shared with the lite
// bridge shell. This module owns only the write policy, CONTROL_TOOLS, and audit
// log, and wires them into `wsBridge` (created below, after runExternalTool).

/** SW-keepalive hooks for in-flight bridge calls (F-8). The WS heartbeat alone
 * does NOT reliably reset MV3's 30s idle timer (§10.19 — only active chrome.*
 * calls do), and bridge calls never populate activeSessions, so a long external
 * sweep could get the SW killed mid-call. The SW registers hooks that run the
 * same active keepalive ping the agent loop uses while ≥1 bridge call is in
 * flight. */
let busyHooks: { onBusy(): void; onIdle(): void } | null = null;
export function setBridgeBusyHooks(h: { onBusy(): void; onIdle(): void }): void {
  busyHooks = h;
}

// The bridge has no "session end" like the SidePanel, so background site tabs an
// external agent opens never get reaped → they accumulate (and a degraded pool
// starts leasing junk tabs). After the bridge goes idle, sweep idle pool tabs
// (reapPoolTabs spares any leased tab + only touches pool-opened tabs, never
// open_url/explore/user tabs). Debounced + cancelled while a call is in flight,
// so it fires only when the bridge is truly quiet. See §10.37; the debounce
// itself is core/idle-sweep, shared with the two headless shells (§10.48).
//
// This shell keeps its agent window standing when the sweep empties it — unlike
// the headless shells, a SidePanel task can start at any moment with the user
// right there, and the placeholder is what stops the window churning per task.
const BRIDGE_REAP_IDLE_MS = 10_000;
const bridgeIdleSweep = createIdleSweep(() => reapPoolTabs(), BRIDGE_REAP_IDLE_MS);

/** Start a fresh explore session on a dedicated tab (mirrors the SW's
 * startExploreSession). Lets the external agent record + use the explore tools. */
async function exploreStart(
  task: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const existing = getActiveExploreSession();
  if (existing) {
    return {
      ok: true,
      result: { traceId: existing.traceId, tabId: existing.tabId, note: 'already active' },
    };
  }
  const tab = await createAgentTab('about:blank');
  if (typeof tab.id !== 'number') return { ok: false, error: 'failed to open explore tab' };
  await adoptTab(tab.id);
  const traceId = `explore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const s = await ExploreSession.start({
    traceId,
    tabId: tab.id,
    task: task || 'external-agent explore',
    owner: 'bridge', // F-30: only bridge /command calls record into this trace
  });
  return { ok: true, result: { traceId: s.traceId, tabId: s.tabId } };
}

async function exploreStop(): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const s = getActiveExploreSession();
  if (!s) return { ok: true, result: { note: 'no active explore session' } };
  const tabId = s.tabId;
  await s.stop('done');
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* tab may already be gone */
  }
  return { ok: true, result: { stopped: true, traceId: s.traceId } };
}

export type { ToolResult }; // re-exported from core/bridge-core (imported above)

const WRITE_DISABLED =
  'External write operations are disabled (enable "Allow external writes" under the extension\'s "External access")';

/** ③a Human handoff over the bridge: an external agent asks the USER to do a step
 * in their browser only a human can (login / captcha / a judgment call), then
 * resumes. Reuses the H9 takeover UI (owner `'bridge'`, surfaced regardless of
 * the panel's current session) + the ③b auto-resume poll. The card only renders
 * in an OPEN SidePanel, so we fail fast with an actionable message when no panel
 * is open instead of blocking for the 5-min timeout. Not gated by the write
 * kill-switch — it's an inbound human step, not an outbound write. */
async function awaitUserActionTool(args: Record<string, unknown>): Promise<ToolResult> {
  const { objective, tabId, resume } = parseAwaitUserAction(args);
  if (!objective) {
    return {
      ok: false,
      error: 'await_user_action needs objective (a one-sentence message to the user explaining what to do)',
    };
  }
  if (keepaliveConnections.size === 0) {
    return {
      ok: false,
      error:
        "Can't request human takeover: the user's Web side panel isn't open, so the takeover card has nowhere to show. Ask the user to open the extension side panel and retry, or take a path that doesn't need a human.",
    };
  }
  void notifyHumanTakeover(objective);
  const resumed = await requestHumanTakeover(
    'bridge',
    'await_user_action',
    tabId,
    undefined,
    objective,
    resume,
  );
  return resumed
    ? { ok: true, result: { resumed: true } }
    : { ok: true, result: { resumed: false, note: "User did not complete it (gave up or timed out); don't pretend it's done" } };
}

// ── synthetic in-extension tools (workflows / shortcuts / memory / LLM) ──
// These mirror the in-conversation agent's create_workflow / create_shortcut /
// remember tools, but run standalone (no agent loop) so an external agent can
// drive the same operations the user does in the extension UI. (The old rigid
// workflow-pipeline tools were removed 2026-07-09; a workflow is now a prompt
// recipe — the bridge exposes it via create_shortcut / list_shortcuts.)

// ── site scripts (ad-blocking / enhancement) — bridge is hide-only (no css/js:
//    those need the in-panel confirm, so they go through the SidePanel agent /
//    manual UI) ──
async function createSiteScriptTool(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (
      (typeof args.css === 'string' && args.css.trim()) ||
      (typeof args.js === 'string' && args.js.trim())
    ) {
      return {
        ok: false,
        error:
          'Site scripts with css/js are not supported over the bridge (they need in-panel user confirmation) — only hide_selectors hiding is. Have the user create the CSS/JS rule in the SidePanel.',
      };
    }
    const matches = (Array.isArray(args.matches) ? args.matches : []).filter(
      (m): m is string => typeof m === 'string',
    );
    const hideSelectors = (Array.isArray(args.hide_selectors) ? args.hide_selectors : []).filter(
      (s): s is string => typeof s === 'string',
    );
    const label = typeof args.label === 'string' ? args.label.trim() : undefined;
    const existing = label ? (await listSiteScripts()).find((s) => s.label === label) : undefined;
    const s = buildSiteScript(
      { ...(label ? { label } : {}), matches, hideSelectors, origin: { type: 'agent' } },
      existing?.id ?? makeSiteScriptId(),
      Date.now(),
    );
    await putSiteScript(s);
    await refreshSiteScript(s.id);
    return {
      ok: true,
      result: {
        id: s.id,
        label: s.label,
        matches: s.matches,
        hidden: s.hideSelectors?.length ?? 0,
        updated: !!existing,
        runnable: siteScriptsRunnable(),
        fragileSelectors: flagFragileSelectors(s.hideSelectors),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function previewSiteScriptTool(args: Record<string, unknown>): Promise<ToolResult> {
  const tabId = typeof args.tab_id === 'number' ? args.tab_id : undefined;
  if (typeof tabId !== 'number') return { ok: false, error: 'preview_site_script needs tab_id' };
  const hideSelectors = (Array.isArray(args.hide_selectors) ? args.hide_selectors : []).filter(
    (s): s is string => typeof s === 'string',
  );
  const css = typeof args.css === 'string' && args.css.trim() ? args.css.trim() : undefined;
  if (!hideSelectors.length && !css) {
    return { ok: false, error: 'preview_site_script needs hide_selectors or css' };
  }
  const r = await previewSiteScript(tabId, hideSelectors, css, args.highlight === true);
  return { ok: true, result: r };
}

async function listSiteScriptsTool(): Promise<ToolResult> {
  const rows = await listSiteScripts();
  return {
    ok: true,
    result: rows.map((s) => ({
      id: s.id,
      label: s.label,
      matches: s.matches,
      hidden: s.hideSelectors?.length ?? 0,
      enabled: s.enabled,
    })),
  };
}

async function deleteSiteScriptTool(args: Record<string, unknown>): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return { ok: false, error: 'delete_site_script needs id' };
  const s = await getSiteScript(id);
  await unregisterSiteScriptById(id);
  await deleteSiteScript(id);
  return { ok: true, result: { deleted: id, label: s?.label ?? null } };
}

async function createShortcutTool(args: Record<string, unknown>): Promise<ToolResult> {
  const label = typeof args.label === 'string' ? args.label.trim() : '';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!label || !text) return { ok: false, error: 'create_shortcut needs label and text' };
  const existing = (await listShortcuts()).find((s) => s.kind === 'prompt' && s.label === label);
  await saveShortcut({ id: existing?.id ?? makeShortcutId(), label, kind: 'prompt', text });
  return { ok: true, result: { saved: label, updated: !!existing } };
}

async function listShortcutsTool(): Promise<ToolResult> {
  const list = await listShortcuts();
  return {
    ok: true,
    result: list.map((s) => ({
      label: s.label,
      kind: s.kind,
      text: s.text ?? '',
      tool: s.tool ?? '',
    })),
  };
}

// Long-term memory is now ONE markdown document (not per-item rows). save_memory
// appends a line; read_memory returns the whole blob. (delete_memory is retired —
// there are no per-item ids; clearing is a `set_memory ""` via save.)
async function saveMemoryTool(args: Record<string, unknown>): Promise<ToolResult> {
  const fact = typeof args.fact === 'string' ? args.fact.trim() : '';
  if (!fact) return { ok: false, error: 'save_memory needs a non-empty fact' };
  const state = await appendMemory(fact);
  return { ok: true, result: { content: state.content } };
}

async function listMemoriesTool(): Promise<ToolResult> {
  const state = await getMemory();
  return { ok: true, result: { enabled: state.enabled, content: state.content } };
}

async function clearMemoryTool(): Promise<ToolResult> {
  const state = await setMemoryContent('');
  return { ok: true, result: { content: state.content } };
}

/** notes (notebook) CRUD — one tool, write-gated PER ACTION: create/update/delete
 * respect the "Allow external writes" switch, while list/search/get stay readable
 * (a static `write: true` on the whole tool would block reads too). */
async function notesTool(args: Record<string, unknown>): Promise<ToolResult> {
  const action = typeof args.action === 'string' ? args.action : '';
  if (NOTES_WRITE_ACTIONS.has(action) && !allowWrites) return { ok: false, error: WRITE_DISABLED };
  return execNotesAction(args);
}

async function getLlmConfigTool(): Promise<ToolResult> {
  const store = await loadProfiles();
  // NEVER return apiKey — only whether one is set.
  return {
    ok: true,
    result: {
      profiles: store.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        provider: p.provider,
        baseUrl: p.baseUrl,
        model: p.model,
        hasKey: !!p.apiKey,
      })),
      slots: store.slots,
    },
  };
}

async function setLlmTool(args: Record<string, unknown>): Promise<ToolResult> {
  const id = typeof args.profile_id === 'string' ? args.profile_id : '';
  if (!id) return { ok: false, error: 'set_llm needs profile_id (see get_llm_config)' };
  const store = await loadProfiles();
  const prof = store.profiles.find((p) => p.id === id);
  if (!prof) return { ok: false, error: `no llm profile ${id} (see get_llm_config)` };
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : '';
  if (model) await upsertProfile({ ...prof, model });
  if (args.as_primary === true) await setActiveProfile(id);
  return {
    ok: true,
    result: { profile: id, model: model || prof.model, primary: args.as_primary === true },
  };
}

/** Load a marketplace adapter for this session (no install). Not write-gated:
 * loading is sandboxed + sha-verified; the loaded adapter's own WRITE calls are
 * gated when they run (below). Refresh the catalog so the loaded tool appears. */
async function loadAdapterTool(args: Record<string, unknown>): Promise<ToolResult> {
  const r = await loadEphemeralAdapter(String(args.site ?? ''), String(args.name ?? ''));
  if (r.ok) refreshBridgeCatalog();
  return r.ok ? { ok: true, result: r } : { ok: false, error: r.error };
}

/** Contribute an installed adapter back to the marketplace (H1/H2-P4): build a
 * pre-filled GitHub issue with its source for the maintainer to audit + merge.
 * Read-class (just builds a URL); the external agent shows it to the user, who
 * reviews + submits on GitHub. Works for an agent-authored OR healed adapter. */
async function contributeAdapterTool(args: Record<string, unknown>): Promise<ToolResult> {
  const site = typeof args.site === 'string' ? args.site.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!site || !name) return { ok: false, error: 'contribute_adapter needs site + name' };
  const id = `${site}/${name}`;
  const inst = await getInstalled(id);
  if (!inst)
    return {
      ok: false,
      error: `${id} is not in the local store — only explore-synthesized adapters can be contributed`,
    };
  const report = buildAdapterReport({
    id,
    tool: `${site}__${name}`,
    source: inst.source,
    version: chrome.runtime.getManifest().version,
  });
  return {
    ok: true,
    result: {
      url: report.url,
      // Source too long to inline in the URL → hand it back so the user can paste it.
      pasteSource: report.clipboard,
      note: 'Open this URL to file a pre-filled GitHub issue with the adapter source for the maintainer to audit + merge into the marketplace. Show it to the user; they review + submit on GitHub.',
    },
  };
}

/** Synthetic tools handled here in the extension (not registry adapters). `write`
 * ones respect the "Allow external writes" kill switch. */
const CONTROL_TOOLS: Record<
  string,
  { write?: boolean; run: (args: Record<string, unknown>) => Promise<ToolResult> }
> = {
  explore_start: { write: true, run: (a) => exploreStart(String(a.task ?? '')) },
  explore_stop: { run: () => exploreStop() },
  // ③a human handoff — pause and ask the user to do a step in their browser.
  await_user_action: { run: awaitUserActionTool },
  load_adapter: { run: loadAdapterTool },
  contribute_adapter: { run: contributeAdapterTool },
  // workflow = a reusable prompt recipe (create_shortcut / list_shortcuts).
  create_shortcut: { write: true, run: createShortcutTool },
  list_shortcuts: { run: listShortcutsTool },
  // site scripts (ad-blocking / enhancement)
  create_site_script: { write: true, run: createSiteScriptTool },
  list_site_scripts: { run: listSiteScriptsTool },
  delete_site_script: { write: true, run: deleteSiteScriptTool },
  preview_site_script: { run: previewSiteScriptTool },
  save_memory: { write: true, run: saveMemoryTool },
  list_memories: { run: listMemoriesTool },
  clear_memory: { write: true, run: clearMemoryTool },
  // notes: single-tool CRUD; write actions are gated dynamically by action inside
  // notesTool (reads are unaffected by the write switch).
  notes: { run: notesTool },
  get_llm_config: { run: getLlmConfigTool },
  set_llm: { write: true, run: setLlmTool },
};

// ── Audit log (H2-P2; H7-P1 makes it durable across SW restarts) — every external
// call's outcome, for the External access page. Mirrored to chrome.storage.session (in-
// memory, cleared on browser close = exactly the audit's lifetime) so an MV3 SW
// death mid-session doesn't wipe the user's view of what the external agent did. ──
const CALL_LOG_CAP = 100;
const LOG_KEY = 'bridgeCallLog';
const recentCalls: BridgeCall[] = [];
function persistLog(): void {
  try {
    void chrome.storage?.session?.set({ [LOG_KEY]: recentCalls });
  } catch {
    /* storage.session unavailable — log stays in-memory only */
  }
}
/** Exported: the web-app Port bridge (external-mcp) records its calls into the
 * SAME audit log the WS bridge writes — one External access view of everything external. */
export function recordCall(tool: string, ok: boolean, error: string | undefined, t0: number): void {
  if (tool === '__echo') return;
  const write = !!CONTROL_TOOLS[tool]?.write || lookupAdapter(tool)?.access === 'write';
  recentCalls.push({ ts: t0, tool, ok, write, error, durationMs: Date.now() - t0 });
  if (recentCalls.length > CALL_LOG_CAP) recentCalls.shift();
  persistLog();
}
/** Newest-first snapshot of recent external calls (audit). */
export function bridgeCallLog(): BridgeCall[] {
  return recentCalls.slice().reverse();
}

/** The shared external-tool executor + write gates, built from the core factory
 * (src/core/bridge-core.ts). The FULL shell injects the rich CONTROL_TOOLS +
 * executeAdapter (all adapters); the lite bridge builds its own with an empty
 * control set + executeGenericTool. Both transports (the WS bridge below and the
 * web-app Port bridge in external-mcp) call these, and each owns its own audit
 * log (recordCall) around them. `origin` tags executeAdapter (F-30 explore
 * isolation): 'bridge' for WS calls; the Port bridge passes 'webmcp' so its
 * calls never record into any explore trace (not even a bridge-owned one). */
const bridge = createBridge({
  execute: executeAdapter,
  controlTools: CONTROL_TOOLS,
  getAllowWrites: () => allowWrites,
  getDenySites: () => denySites,
  writeDisabledMsg: WRITE_DISABLED,
  onBusy: () => busyHooks?.onBusy(),
  onIdle: () => busyHooks?.onIdle(),
  onCallStart: bridgeIdleSweep.onCallStart, // a call is in flight — don't reap under it
  onCallEnd: bridgeIdleSweep.onCallEnd, // call done → sweep idle pool tabs if quiet
});
export const runExternalTool = bridge.runExternalTool;
export const isExternalTool = bridge.isExternalTool;

// ── WebSocket transport (core/ws-bridge) — wired with this shell's executor +
//    audit log. The socket lifecycle, heartbeat, reconnect, and call→run→reply
//    loop live in core; this module just supplies runExternalTool + recordCall. ──
const wsBridge = createWsBridge({
  defaultPort: DEFAULT_PORT,
  clientName: 'web-agent',
  clientVersion: () => chrome.runtime.getManifest().version,
  buildCatalog: () => openAiToolsFromRegistry(),
  runCall: (tool, args) => runExternalTool(tool, args),
  recordCall,
  callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
});

/** Re-push the tool catalog to the bridge after the installed set changes. */
export function refreshBridgeCatalog(): void {
  wsBridge.refreshCatalog();
}

/** Read persisted state and connect if enabled. Called at SW startup. */
export async function initBridge(): Promise<void> {
  let enabled = false;
  let startPort = DEFAULT_PORT;
  try {
    const got = await chrome.storage.local.get([ENABLED_KEY, PORT_KEY, ALLOW_WRITES_KEY, DENY_KEY]);
    enabled = !!got[ENABLED_KEY];
    startPort = Number(got[PORT_KEY]) || DEFAULT_PORT;
    allowWrites = got[ALLOW_WRITES_KEY] !== false; // default true
    denySites = Array.isArray(got[DENY_KEY]) ? got[DENY_KEY] : [];
  } catch {
    /* ignore */
  }
  // H7-P1: restore the audit log so it survives a SW restart within the session.
  try {
    const sess = await chrome.storage.session.get(LOG_KEY);
    const saved = sess[LOG_KEY];
    if (Array.isArray(saved) && recentCalls.length === 0) {
      recentCalls.push(...(saved as BridgeCall[]).slice(-CALL_LOG_CAP));
    }
  } catch {
    /* ignore */
  }
  wsBridge.start(enabled, startPort);
}

/** Enable/disable (persisted) and (re)connect or disconnect accordingly. */
export async function setBridgeEnabled(
  enabled: boolean,
  newPort?: number,
  newAllowWrites?: boolean,
  newDenySites?: string[],
): Promise<void> {
  if (typeof newAllowWrites === 'boolean') allowWrites = newAllowWrites;
  if (Array.isArray(newDenySites)) denySites = newDenySites.map((x) => x.trim()).filter(Boolean);
  wsBridge.setEnabled(enabled, newPort); // owns want/port + close/reconnect
  await chrome.storage.local.set({
    [ENABLED_KEY]: enabled,
    [PORT_KEY]: wsBridge.status().port,
    [ALLOW_WRITES_KEY]: allowWrites,
    [DENY_KEY]: denySites,
  });
}

export function bridgeStatus(): {
  enabled: boolean;
  connected: boolean;
  port: number;
  allowWrites: boolean;
  denySites: string[];
} {
  const s = wsBridge.status();
  return {
    enabled: s.enabled,
    connected: s.connected,
    port: s.port,
    allowWrites,
    denySites: [...denySites],
  };
}
