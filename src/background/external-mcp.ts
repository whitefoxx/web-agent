/**
 * External MCP tool source — FULL-shell wrapper. Lets an ALLOWED web app
 * (localmd.app, listed in the manifest's `externally_connectable`) connect with
 * `chrome.runtime.connect(EXTENSION_ID)` and talk JSON-RPC 2.0 shaped like MCP
 * (initialize / tools/list / tools/call). Two tiers of tools:
 *
 *  - `web_task` (synthetic): the caller delegates a whole "browse the web" task;
 *    we drive it through the SAME engine as a SidePanel turn (driveApiSession —
 *    same LLM profile, same write-confirm gates, same budget) and return only
 *    the final assistant text. Progress streams back as `notifications/progress`.
 *  - The full external tool catalog (every registered adapter, same set the WS
 *    bridge pushes): executed via bridge-client's shared `runExternalTool`, so
 *    the "Allow external writes" kill switch + per-site deny list gate BOTH
 *    transports with one copy of the logic. Image-bearing results (screenshot
 *    dataUrl) come back as MCP `{type:'image'}` content blocks.
 *
 * The JSON-RPC transport itself lives in `src/core/external-mcp-core.ts` (shared
 * with the lite bridge shell); this file only injects the `web_task` delegate +
 * the shared executor. web_task runs with autoApprove=false — every write still
 * hits the in-panel confirm card; direct tool calls respect the External access
 * switches exactly like WS-bridge calls. Nothing here bypasses or relaxes gates.
 *
 * MV3 caveat: while a task runs, driveApiSession's keepalive pins the worker; an
 * IDLE connected port does not (§10.19), so the SW may be recycled between calls
 * — the page sees onDisconnect and should reconnect. See
 * docs/external-agent-control.md §8/§11.
 */

import { log, warn } from '@base/runtime/log';
import { makeSession, makeSessionId, type SessionState } from '../agent/session';
import { loadLlmConfig } from '../config/llm-config';
import { driveApiSession } from './engine-driver';
import { observeOrchEvents } from './orch-events';
import { msgOf } from '@base/background/runtime-state';
import { activeSessions } from './active-sessions';
import {
  runExternalTool,
  isExternalTool,
  recordCall,
  BRIDGE_CALL_TIMEOUT_MS,
} from './bridge-client';
import {
  createExternalMcpHandler,
  type McpTool,
  type WebTaskContext,
} from '@base/core/external-mcp-core';

// Re-export for API continuity (callers/tests that referenced these on this module).
export { MCP_PROTOCOL_VERSION, allowedExternalOrigins } from '@base/core/external-mcp-core';

const SCOPE = 'ext-mcp';

const WEB_TASK_TOOL: McpTool = {
  name: 'web_task',
  description:
    'Delegate a whole web-browsing task (search, open pages, read and summarize, etc.) to the browser agent to execute end to end, returning the final text result. The task description must be self-contained.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The complete task description' },
    },
    required: ['task'],
  },
};

/** Last assistant turn's text — the run's final answer (same walk the desktop
 * notification uses). */
function finalAnswerOf(session: SessionState): string {
  for (let i = session.history.length - 1; i >= 0; i--) {
    const t = session.history[i];
    if (t.role === 'assistant' && t.cleanedText) return t.cleanedText;
  }
  return '';
}

/** The web_task delegate: drive one whole browse-task through the agent engine
 * and reply with the final assistant text (progress streamed meanwhile). */
async function runWebTask(ctx: WebTaskContext): Promise<void> {
  const { state, args } = ctx;
  if (state.closed) return;
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  if (!task) {
    ctx.sendError(-32602, 'web_task needs a non-empty string parameter "task"');
    return;
  }

  // Same readiness check the engine enforces — but fail as a TOOL result (the
  // calling agent can relay it to its user) instead of deep inside the run.
  const cfg = await loadLlmConfig().catch(() => null);
  if (!cfg?.apiKey) {
    ctx.sendText('Please configure a model in web-agent settings first (side panel → Settings → Model roles).', true);
    return;
  }

  const session = makeSession(makeSessionId());
  state.runningSessionId = session.id;
  let engineError: string | undefined;
  const unobserve = observeOrchEvents(session.id, (evt) => {
    if (evt.type === 'tool_trace' && evt.trace.status === 'started') {
      ctx.sendProgress(`Tool: ${evt.trace.tool ?? evt.trace.action}`);
    } else if (evt.type === 'notice') {
      ctx.sendProgress(evt.text);
    } else if (evt.type === 'session_done' && evt.error) {
      engineError = evt.error;
    }
  });
  log(SCOPE, `web_task start session=${session.id}`, { task: task.slice(0, 80) });
  try {
    // autoApprove=false — external tasks get NO special trust: writes surface
    // the same confirm card as a SidePanel run (panel closed → they time out
    // declined, so an external task is effectively read-only unless the user is
    // present to approve).
    await driveApiSession(session, task, 'chat', undefined, false, {
      // Full task text as the bubble label (display-only). The 🌐 prefix marks it
      // as an external task in History.
      displayText: `🌐 External task: ${task}`,
    });
    if (state.closed) return;
    if (session.status === 'error') {
      ctx.sendText(`Task failed: ${engineError ?? 'see the extension History for details'}`, true);
    } else if (session.status === 'aborted') {
      ctx.sendText('Task aborted.', true);
    } else {
      const answer = finalAnswerOf(session);
      ctx.sendText(answer || '(Task complete, but produced no text answer)', false);
    }
  } catch (e) {
    warn(SCOPE, 'web_task failed', e);
    if (!state.closed) ctx.sendText(`Task failed: ${msgOf(e)}`, true);
  } finally {
    unobserve();
    state.runningSessionId = null;
  }
}

const WEB_AGENT_INSTRUCTIONS =
  "Web Agent drives the user's logged-in Chrome. Two ways: (1) delegate a whole browse task via " +
  'web_task {task} — it runs the in-browser agent end to end (login, site adapters, write-confirms) ' +
  'and returns the final text; best for multi-step goals. (2) call tools directly: generic browser ' +
  'primitives (open_url/get_page_text/get_interactives/click/type_into) + any loaded site adapters. ' +
  'Prefer TEXT over images: get_page_text is cheap; only screenshot for visual/non-text tasks (images ' +
  'cost many tokens). Call tools/list for the exact surface.';

/** chrome.runtime.onConnectExternal entry — registered in service-worker.ts. */
export const handleExternalConnect = createExternalMcpHandler({
  runExternalTool,
  isExternalTool,
  recordCall,
  callTimeoutMs: BRIDGE_CALL_TIMEOUT_MS,
  serverName: 'web-agent',
  serverVersion: () => chrome.runtime.getManifest().version,
  webTask: { tool: WEB_TASK_TOOL, run: runWebTask },
  abortSession: (id) => activeSessions.get(id)?.abort.abort(),
  instructions: WEB_AGENT_INSTRUCTIONS,
  scope: SCOPE,
});
