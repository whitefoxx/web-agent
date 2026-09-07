/**
 * Translate the engine's internal `OrchEvent` stream into the SidePanel wire
 * protocol (`*_Evt` messages) and broadcast them. Shared by the engine driver
 * (ctx.emit) and the explore driver (synthesize_adapter status), so it lives in
 * its own module to keep those two free of a circular dependency.
 */

import type { OrchEvent } from '../agent/engine';
import { sendToSidepanel } from '@base/background/runtime-state';
import type {
  AssistantTurnEvt,
  AssistantTurnPatchEvt,
  RunStatsEvt,
  IterationProgressEvt,
  SessionDoneEvt,
  SessionNoticeEvt,
  SubagentEvt,
  PlanUpdatedEvt,
  ExploreAdapterEvt,
  ToolTraceEvt,
} from '../messages';

/** Per-session side observers (currently: external-mcp progress notifications).
 * The SidePanel broadcast below stays the primary consumer; observers get the
 * SAME event stream without engine-driver having to thread an extra callback. */
const orchObservers = new Map<string, Set<(evt: OrchEvent) => void>>();

/** Subscribe to a session's OrchEvent stream. Returns the unsubscribe fn. */
export function observeOrchEvents(sessionId: string, fn: (evt: OrchEvent) => void): () => void {
  let set = orchObservers.get(sessionId);
  if (!set) {
    set = new Set();
    orchObservers.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    const cur = orchObservers.get(sessionId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) orchObservers.delete(sessionId);
  };
}

export function forwardOrchEvent(sessionId: string, evt: OrchEvent): void {
  const observers = orchObservers.get(sessionId);
  if (observers) {
    for (const fn of observers) {
      try {
        fn(evt);
      } catch {
        /* an observer must never break the SidePanel broadcast */
      }
    }
  }
  switch (evt.type) {
    case 'assistant_turn': {
      const out: AssistantTurnEvt = {
        type: 'ASSISTANT_TURN',
        sessionId,
        iteration: evt.iteration,
        cleanedText: evt.cleanedText,
        rawText: evt.rawText,
        reasoningText: evt.reasoningText,
        commands: evt.commands,
      };
      sendToSidepanel(out);
      break;
    }
    case 'assistant_delta': {
      const out: AssistantTurnPatchEvt = {
        type: 'ASSISTANT_TURN_PATCH',
        sessionId,
        iteration: evt.iteration,
        text: evt.text,
      };
      sendToSidepanel(out);
      break;
    }
    case 'run_stats': {
      const out: RunStatsEvt = {
        type: 'RUN_STATS',
        sessionId,
        step: evt.step,
        promptTokens: evt.promptTokens,
        completionTokens: evt.completionTokens,
      };
      sendToSidepanel(out);
      break;
    }
    case 'tool_trace': {
      const out: ToolTraceEvt = { type: 'TOOL_TRACE', sessionId, trace: evt.trace };
      sendToSidepanel(out);
      break;
    }
    case 'iteration_progress': {
      const out: IterationProgressEvt = {
        type: 'ITERATION_PROGRESS',
        sessionId,
        iterationId: evt.iterationId,
        iteration: evt.iteration,
        phase: evt.phase,
        textLen: evt.textLen,
      };
      sendToSidepanel(out);
      break;
    }
    case 'session_done': {
      const out: SessionDoneEvt = {
        type: 'SESSION_DONE',
        sessionId,
        reason: evt.reason,
        error: evt.error,
      };
      sendToSidepanel(out);
      break;
    }
    case 'notice': {
      const out: SessionNoticeEvt = {
        type: 'SESSION_NOTICE',
        sessionId,
        level: evt.level,
        text: evt.text,
      };
      sendToSidepanel(out);
      break;
    }
    case 'plan_updated': {
      const out: PlanUpdatedEvt = { type: 'PLAN_UPDATED', sessionId, plan: evt.plan };
      sendToSidepanel(out);
      break;
    }
    case 'explore_adapter': {
      const out: ExploreAdapterEvt = {
        type: 'EXPLORE_ADAPTER',
        sessionId,
        adapter: evt.adapter,
      };
      sendToSidepanel(out);
      break;
    }
    case 'subagent': {
      const out: SubagentEvt = {
        type: 'SUBAGENT_EVT',
        sessionId,
        phase: evt.phase,
        id: evt.id,
        task: evt.task,
        ok: evt.ok,
        digestChars: evt.digestChars,
        durationMs: evt.durationMs,
      };
      sendToSidepanel(out);
      break;
    }
  }
}
