/**
 * The central message router — one big switch over every `Message` the SidePanel
 * (and other extension pages) can send. The MV3 onMessage contract: return `true`
 * to keep the channel open for an async `sendResponse`, `false`/`undefined` when
 * we've already responded synchronously. Each case just delegates to a handler in
 * the domain modules; this file is the index of "everything the panel can do".
 *
 * Registered from the SW entry: `chrome.runtime.onMessage.addListener(routeMessage)`.
 */

import { ingestEntry, getLocalBuffer } from '@base/runtime/log';
import { getMemory, setMemoryContent, setMemoryEnabled } from '../agent/memory-store';
import { editMemoryWithLLM } from '../agent/memory-edit';
import {
  listSiteScripts,
  setSiteScriptEnabled,
  deleteSiteScript,
  buildSiteScript,
  putSiteScript,
  getSiteScript,
  makeSiteScriptId,
} from '@base/site-scripts/store';
import {
  refreshSiteScript,
  unregisterSiteScriptById,
  siteScriptsRunnable,
} from '@base/site-scripts/register';
import { listNotes, addNote, updateNote, deleteNote } from '../agent/notes-store';
import { runScheduleNow, syncAlarm } from './schedule-runner';
import { listSchedules, saveSchedule, deleteSchedule, alarmName } from '../schedules/store';
import { getAllHealth } from '../adapters/adapter-health-store';
import { getTrace } from '../explore/trace-store';
import {
  findStaleMarketplaceAdapters,
  markVerified,
  loadInstalledOnBoot,
} from '../adapters/install-manager';
import { isUserScriptsApiAvailable } from '../userscript/sw-runner';
import { getInstalled } from '../adapters/installed-store';
import { allAdapterCommands } from '@base/tools/manifest';
import { bridgeStatus, bridgeCallLog, setBridgeEnabled } from './bridge-client';
import { loadEphemeralAdapter } from './ephemeral-adapter';
import { msgOf } from '@base/background/runtime-state';
import { activeSessions } from './active-sessions';
import { isMaskAlive } from './mask-keeper';
import { handleUserMessage, handleAbort, handleSteer, handleInjectContext } from './engine-driver';
import { handleListSessions, handleGetSession, handleDeleteSession } from './session-handlers';
import {
  handleWriteConfirmResp,
  handleHumanTakeoverResp,
  handlePlanDecisionResp,
} from './confirm-prompts';
import {
  handleInstallAdapter,
  handleUninstallAdapter,
  handleSetAdapterEnabled,
  handleListInstalled,
  handleRegisterSessionAdapter,
  broadcastAdaptersChanged,
} from './adapter-handlers';
import { handleRunTool, handleExploreRepair, handleImportTrace } from './explore-driver';
import { handleSelectionLlm, handleSelectionAsk } from './selection-actions';
import type {
  Message,
  UserMessageReq,
  AbortSessionReq,
  SteerMessageReq,
  RequestLogsReq,
  LogsResponse,
  ListSessionsReq,
  GetSessionReq,
  DeleteSessionReq,
  WriteConfirmResp,
  HumanTakeoverResp,
  PlanDecisionResp,
  LogEntryEvt,
  InstallAdapterReq,
  LoadAdapterReq,
  RegisterSessionAdapterReq,
  UninstallAdapterReq,
  SetAdapterEnabledReq,
  GetAdapterSourceReq,
  GetAdapterSourceResp,
  GetAdapterCommandsReq,
  GetAdapterCommandsResp,
  AdapterCommand,
  InjectContextReq,
  SetBridgeEnabledReq,
  GetTraceReq,
  SetAdapterVerifyReq,
  SetMemoryReq,
  SetMemoryEnabledReq,
  EditMemoryLlmReq,
  SetSiteScriptEnabledReq,
  DeleteSiteScriptReq,
  CreateSiteScriptReq,
  ImportSiteScriptsReq,
  SaveScheduleReq,
  DeleteScheduleReq,
  RunScheduleNowReq,
  AddNoteReq,
  UpdateNoteReq,
  DeleteNoteReq,
  RunToolReq,
  ExploreRepairReq,
  ImportTraceReq,
  SelectionLlmReq,
  SelectionAskReq,
} from '../messages';

function handleRequestLogs(_m: RequestLogsReq): LogsResponse {
  return { type: 'LOGS_RESPONSE', entries: getLocalBuffer() };
}

export function routeMessage(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Message;
  switch (m.type) {
    case 'MASK_PING': {
      // In-page cockpit-mask heartbeat (mask-keeper): alive while the run is
      // still driving the sender's tab. Sync answer, hot path — keep it first.
      sendResponse({ alive: isMaskAlive(sender.tab?.id ?? -1, activeSessions.size > 0) });
      return false;
    }
    case 'REREGISTER_ADAPTERS': {
      // "Allow user scripts just enabled" recovery (adapter-hot-plug §10.38): re-run
      // the boot registration so deferred func adapters become runnable without
      // restarting the browser. Idempotent (re-register overwrites).
      if (!isUserScriptsApiAvailable()) {
        sendResponse({ ok: true, available: false, adapters: 0, commands: 0 });
        return false;
      }
      void loadInstalledOnBoot().then(
        (r) => sendResponse({ ok: true, available: true, ...r }),
        (e) => sendResponse({ ok: false, available: true, adapters: 0, commands: 0, error: msgOf(e) }),
      );
      return true;
    }
    case 'USER_MESSAGE': {
      const r = m as UserMessageReq;
      sendResponse({ ok: true });
      void handleUserMessage(r);
      return false;
    }
    case 'ABORT_SESSION': {
      handleAbort(m as AbortSessionReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'STEER_MESSAGE': {
      handleSteer(m as SteerMessageReq);
      sendResponse({ ok: true });
      return false;
    }
    case 'REQUEST_LOGS': {
      sendResponse(handleRequestLogs(m as RequestLogsReq));
      return false;
    }
    case 'GET_SESSION_STATE': {
      sendResponse({ activeSessionIds: [...activeSessions.keys()] });
      return false;
    }
    case 'LIST_SESSIONS': {
      void handleListSessions(m as ListSessionsReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'GET_SESSION': {
      void handleGetSession(m as GetSessionReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'DELETE_SESSION': {
      void handleDeleteSession(m as DeleteSessionReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'SELECTION_LLM': {
      void handleSelectionLlm(m as SelectionLlmReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'SELECTION_ASK': {
      // Must stay synchronous: sidePanel.open() needs the user-gesture context.
      handleSelectionAsk(m as SelectionAskReq, sender);
      sendResponse({ ok: true });
      return false;
    }
    case 'WRITE_CONFIRM_RESP': {
      handleWriteConfirmResp(m as WriteConfirmResp);
      return false;
    }
    case 'HUMAN_TAKEOVER_RESP': {
      handleHumanTakeoverResp(m as HumanTakeoverResp);
      return false;
    }
    case 'PLAN_DECISION_RESP': {
      handlePlanDecisionResp(m as PlanDecisionResp);
      return false;
    }
    case 'LOG_ENTRY': {
      ingestEntry((m as LogEntryEvt).entry);
      return false;
    }
    case 'INSTALL_ADAPTER': {
      void handleInstallAdapter(m as InstallAdapterReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ type: 'INSTALL_ADAPTER_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'LOAD_ADAPTER': {
      const lr = m as LoadAdapterReq;
      void loadEphemeralAdapter(lr.site, lr.name).then(
        (r) => {
          if (r.ok) broadcastAdaptersChanged();
          sendResponse({
            type: 'LOAD_ADAPTER_RESP',
            ok: r.ok,
            commands: r.commands,
            error: r.error,
          });
        },
        (e) => sendResponse({ type: 'LOAD_ADAPTER_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'REGISTER_SESSION_ADAPTER': {
      void handleRegisterSessionAdapter(m as RegisterSessionAdapterReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ type: 'REGISTER_SESSION_ADAPTER_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'UNINSTALL_ADAPTER': {
      void handleUninstallAdapter(m as UninstallAdapterReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'SET_ADAPTER_ENABLED': {
      void handleSetAdapterEnabled(m as SetAdapterEnabledReq).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'LIST_INSTALLED': {
      void handleListInstalled().then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'GET_ADAPTER_SOURCE': {
      const id = (m as GetAdapterSourceReq).id;
      void getInstalled(id).then(
        (row) =>
          sendResponse({
            type: 'GET_ADAPTER_SOURCE_RESP',
            source: row?.source,
            title: row?.title,
          } satisfies GetAdapterSourceResp),
        () => sendResponse({ type: 'GET_ADAPTER_SOURCE_RESP' } satisfies GetAdapterSourceResp),
      );
      return true;
    }
    case 'GET_ADAPTER_COMMANDS': {
      const id = (m as GetAdapterCommandsReq).id;
      void getInstalled(id).then(
        (row) =>
          sendResponse({
            type: 'GET_ADAPTER_COMMANDS_RESP',
            commands: (row?.defs ?? []).map((d) => ({
              tool: `${d.site}__${d.name}`,
              site: d.site,
              name: d.name,
              description: d.description,
              access: d.access,
              args: d.args as AdapterCommand['args'],
              columns: d.columns,
              kind: d.kind,
            })),
          } satisfies GetAdapterCommandsResp),
        () => sendResponse({ type: 'GET_ADAPTER_COMMANDS_RESP', commands: [] }),
      );
      return true;
    }
    case 'GET_ALL_TOOLS': {
      sendResponse({ type: 'GET_ALL_TOOLS_RESP', commands: allAdapterCommands() });
      return false;
    }
    case 'INJECT_CONTEXT': {
      void handleInjectContext(m as InjectContextReq).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    case 'GET_BRIDGE_STATUS': {
      sendResponse({ type: 'GET_BRIDGE_STATUS_RESP', ...bridgeStatus() });
      return false;
    }
    case 'GET_BRIDGE_LOG': {
      sendResponse({ type: 'GET_BRIDGE_LOG_RESP', calls: bridgeCallLog() });
      return false;
    }
    case 'SET_BRIDGE_ENABLED': {
      const r = m as SetBridgeEnabledReq;
      void setBridgeEnabled(r.enabled, r.port, r.allowWrites, r.writeDenySites).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    case 'LIST_STALE_ADAPTERS': {
      void findStaleMarketplaceAdapters().then(
        (stale) => sendResponse({ type: 'LIST_STALE_ADAPTERS_RESP', stale }),
        () => sendResponse({ type: 'LIST_STALE_ADAPTERS_RESP', stale: [] }),
      );
      return true;
    }
    case 'GET_MEMORY': {
      void getMemory().then(
        (state) => sendResponse({ type: 'MEMORY_STATE', state }),
        () => sendResponse({ type: 'MEMORY_STATE', state: { enabled: true, content: '', updatedAt: 0 } }),
      );
      return true;
    }
    case 'LIST_SITE_SCRIPTS': {
      void listSiteScripts().then(
        (scripts) =>
          sendResponse({
            type: 'LIST_SITE_SCRIPTS_RESP',
            scripts,
            runnable: siteScriptsRunnable(),
          }),
        () =>
          sendResponse({
            type: 'LIST_SITE_SCRIPTS_RESP',
            scripts: [],
            runnable: siteScriptsRunnable(),
          }),
      );
      return true;
    }
    case 'SET_SITE_SCRIPT_ENABLED': {
      const r = m as SetSiteScriptEnabledReq;
      void setSiteScriptEnabled(r.id, r.enabled)
        .then(() => refreshSiteScript(r.id))
        .then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
      return true;
    }
    case 'DELETE_SITE_SCRIPT': {
      const id = (m as DeleteSiteScriptReq).id;
      void unregisterSiteScriptById(id)
        .then(() => deleteSiteScript(id))
        .then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
      return true;
    }
    case 'CREATE_SITE_SCRIPT': {
      // Manual authoring / edit from the sidebar form (user-authored → no confirm).
      const r = m as CreateSiteScriptReq;
      void (async () => {
        try {
          const prev = r.id ? await getSiteScript(r.id) : null;
          const s = buildSiteScript(r.input, r.id ?? makeSiteScriptId(), Date.now());
          if (prev) s.createdAt = prev.createdAt; // preserve on edit
          await putSiteScript(s);
          await refreshSiteScript(s.id);
          sendResponse({ type: 'SITE_SCRIPT_MUT_RESP', script: s });
        } catch (e) {
          sendResponse({ type: 'SITE_SCRIPT_MUT_RESP', script: null, error: msgOf(e) });
        }
      })();
      return true;
    }
    case 'IMPORT_SITE_SCRIPTS': {
      const r = m as ImportSiteScriptsReq;
      void (async () => {
        let imported = 0;
        let failed = 0;
        for (const raw of Array.isArray(r.scripts) ? r.scripts : []) {
          try {
            const o = (raw ?? {}) as Record<string, unknown>;
            const s = buildSiteScript(
              {
                ...(typeof o.label === 'string' ? { label: o.label } : {}),
                matches: Array.isArray(o.matches) ? (o.matches as string[]) : [],
                ...(Array.isArray(o.hideSelectors)
                  ? { hideSelectors: o.hideSelectors as string[] }
                  : {}),
                ...(typeof o.css === 'string' ? { css: o.css } : {}),
                ...(typeof o.js === 'string' ? { js: o.js } : {}),
                ...(typeof o.runAt === 'string' ? { runAt: o.runAt } : {}),
                enabled: o.enabled !== false,
                origin: { type: 'manual', note: 'imported' },
              },
              makeSiteScriptId(),
              Date.now(),
            );
            await putSiteScript(s);
            await refreshSiteScript(s.id);
            imported++;
          } catch {
            failed++;
          }
        }
        sendResponse({ type: 'IMPORT_SITE_SCRIPTS_RESP', imported, failed });
      })();
      return true;
    }
    case 'RUN_TOOL': {
      void handleRunTool(m as RunToolReq).then(
        (resp) => sendResponse(resp),
        (e) => sendResponse({ type: 'RUN_TOOL_RESP', ok: false, error: msgOf(e) }),
      );
      return true;
    }
    case 'EXPLORE_REPAIR': {
      sendResponse({ ok: true });
      void handleExploreRepair(m as ExploreRepairReq);
      return false;
    }
    case 'IMPORT_TRACE': {
      sendResponse({ ok: true });
      void handleImportTrace(m as ImportTraceReq);
      return false;
    }
    case 'GET_TRACE': {
      void getTrace((m as GetTraceReq).traceId).then(
        (trace) => sendResponse({ type: 'GET_TRACE_RESP', trace }),
        () => sendResponse({ type: 'GET_TRACE_RESP', trace: null }),
      );
      return true;
    }
    case 'SET_ADAPTER_VERIFY': {
      const r = m as SetAdapterVerifyReq;
      void markVerified(r.id, r.status, r.note).then(
        () => {
          broadcastAdaptersChanged();
          sendResponse({ ok: true });
        },
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    case 'SET_MEMORY': {
      void setMemoryContent((m as SetMemoryReq).content).then(
        (state) => sendResponse({ type: 'MEMORY_STATE', state }),
        () => sendResponse({ type: 'MEMORY_STATE', state: null }),
      );
      return true;
    }
    case 'SET_MEMORY_ENABLED': {
      void setMemoryEnabled((m as SetMemoryEnabledReq).enabled).then(
        (state) => sendResponse({ type: 'MEMORY_STATE', state }),
        () => sendResponse({ type: 'MEMORY_STATE', state: null }),
      );
      return true;
    }
    case 'EDIT_MEMORY_LLM': {
      // Scoped LLM rewrite of the blob, then persist. Returns the new state so the
      // panel can refresh without a second round-trip.
      void (async () => {
        const cur = await getMemory();
        const r = await editMemoryWithLLM(cur.content, (m as EditMemoryLlmReq).instruction);
        if (r.error || r.content == null) {
          sendResponse({ type: 'MEMORY_EDIT_RESP', state: null, error: r.error });
          return;
        }
        const state = await setMemoryContent(r.content);
        sendResponse({ type: 'MEMORY_EDIT_RESP', state });
      })().catch(() =>
        sendResponse({ type: 'MEMORY_EDIT_RESP', state: null, error: 'Update failed, please try again.' }),
      );
      return true;
    }
    case 'GET_ADAPTER_HEALTH': {
      void getAllHealth().then(
        (health) => sendResponse({ type: 'GET_ADAPTER_HEALTH_RESP', health }),
        () => sendResponse({ type: 'GET_ADAPTER_HEALTH_RESP', health: [] }),
      );
      return true;
    }
    case 'LIST_SCHEDULES': {
      void listSchedules().then(
        (schedules) => sendResponse({ type: 'SCHEDULES_RESP', schedules }),
        () => sendResponse({ type: 'SCHEDULES_RESP', schedules: [] }),
      );
      return true;
    }
    case 'SAVE_SCHEDULE': {
      const sch = (m as SaveScheduleReq).schedule;
      void saveSchedule(sch).then(
        async (schedules) => {
          await syncAlarm(sch);
          sendResponse({ type: 'SCHEDULES_RESP', schedules });
        },
        () => sendResponse({ type: 'SCHEDULES_RESP', schedules: [] }),
      );
      return true;
    }
    case 'DELETE_SCHEDULE': {
      const id = (m as DeleteScheduleReq).id;
      void deleteSchedule(id).then(
        async (schedules) => {
          try {
            await chrome.alarms.clear(alarmName(id));
          } catch {
            /* ignore */
          }
          sendResponse({ type: 'SCHEDULES_RESP', schedules });
        },
        () => sendResponse({ type: 'SCHEDULES_RESP', schedules: [] }),
      );
      return true;
    }
    case 'RUN_SCHEDULE_NOW': {
      void runScheduleNow((m as RunScheduleNowReq).id).then(
        (r) =>
          sendResponse({
            type: 'RUN_SCHEDULE_NOW_RESP',
            ok: r.ok,
            error: r.error,
            sessionId: r.sessionId,
          }),
        (e) => sendResponse({ type: 'RUN_SCHEDULE_NOW_RESP', ok: false, error: String(e) }),
      );
      return true;
    }
    case 'LIST_NOTES': {
      void listNotes().then(
        (notes) => sendResponse({ type: 'LIST_NOTES_RESP', notes }),
        () => sendResponse({ type: 'LIST_NOTES_RESP', notes: [] }),
      );
      return true;
    }
    case 'ADD_NOTE': {
      const req = m as AddNoteReq;
      void addNote({ title: req.title, content: req.content, source: req.source }).then(
        (note) => sendResponse({ type: 'NOTE_MUT_RESP', note }),
        () => sendResponse({ type: 'NOTE_MUT_RESP', note: null }),
      );
      return true;
    }
    case 'UPDATE_NOTE': {
      const req = m as UpdateNoteReq;
      void updateNote(req.id, { title: req.title, content: req.content }).then(
        (note) => sendResponse({ type: 'NOTE_MUT_RESP', note }),
        () => sendResponse({ type: 'NOTE_MUT_RESP', note: null }),
      );
      return true;
    }
    case 'DELETE_NOTE': {
      void deleteNote((m as DeleteNoteReq).id).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    default:
      return;
  }
}
