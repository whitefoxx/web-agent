import { Component } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Markdown } from './Markdown';
import { AdaptersSection } from './Adapters';
import {
  IconArrowUp,
  IconBrand,
  IconChevronLeft,
  IconClock,
  IconCog,
  IconMenu,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconStop,
  IconTerminal,
  IconX,
  IconFlag,
  IconEye,
  IconSearch,
  IconCamera,
  IconPointer,
  IconType,
  IconScroll,
  IconList,
  IconBranch,
  IconSave,
  IconImage,
  IconGlobe,
  IconCheckCircle,
  IconChevronDown,
  IconDot,
  IconHand,
  IconFastForward,
  IconCheck,
  IconCopy,
  IconSparkle,
} from './Icons';
import { toolActivity, screenshotDataUrl, planSites, type ActivityIcon } from './activity';
import type { UiTurn } from './types';
import {
  type AbortSessionReq,
  type SteerMessageReq,
  type AssistantTurnEvt,
  type AssistantTurnPatchEvt,
  type RunStatsEvt,
  type DeleteSessionReq,
  type GetSessionReq,
  type GetSessionResp,
  type IterationProgressEvt,
  type ListSessionsReq,
  type ListSessionsResp,
  type LogEntryEvt,
  type LogsResponse,
  type Message,
  type RequestLogsReq,
  type SessionDoneEvt,
  type SessionNoticeEvt,
  type PlanUpdatedEvt,
  type SessionSummary,
  type ToolTrace,
  type ToolTraceEvt,
  type UserMessageReq,
  type WriteConfirmReq,
  type WriteConfirmResp,
  type PlanDecisionReq,
  type PlanDecisionResp,
  type ListMemoriesReq,
  type ListMemoriesResp,
  type DeleteMemoryReq,
} from '../messages';
import type { SessionState, Turn } from '../agent/session';
import type { PlanState } from '../agent/plan';
import type { MemoryFact } from '../agent/memory-store';
import type { LogEntry, LogConfig } from '../runtime/log';
import { getLogConfig, setLogConfig, subscribeLog } from '../runtime/log';
import { reconcileStaleAdapters } from './adapters-client';
import { makeSessionId } from '../agent/session';
import {
  DEFAULT_CONFIG,
  PROVIDERS,
  CAPABILITIES,
  loadLlmConfig,
  loadProfiles,
  upsertProfile,
  deleteProfile,
  setSlot,
  newProfileId,
  autoLabel,
  providerById,
  type Capability,
  type LlmConfig,
  type LlmProfile,
  type LlmProfileStore,
} from '../config/llm-config';

interface ProgressState {
  iteration: number;
  phase: 'injecting' | 'awaiting' | 'streaming';
  textLen?: number;
}

type View = 'closed' | 'menu' | 'backend' | 'adapters' | 'history' | 'memory' | 'logs';

const PAGE_LABELS: Record<Exclude<View, 'closed' | 'menu'>, string> = {
  backend: 'LLM 后端',
  adapters: 'Adapters',
  history: '历史会话',
  memory: '记忆',
  logs: '日志',
};

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const ACTIVITY_ICON: Record<ActivityIcon, (p: { size?: number }) => preact.JSX.Element> = {
  navigate: IconFlag,
  read: IconEye,
  search: IconSearch,
  camera: IconCamera,
  click: IconPointer,
  type: IconType,
  scroll: IconScroll,
  plan: IconList,
  subagent: IconBranch,
  memory: IconSave,
  image: IconImage,
  site: IconGlobe,
  action: IconDot,
};

type TurnKind = 'user' | 'system' | 'tool' | 'reasoning' | 'answer';

/** An assistant turn is "reasoning" (a timeline narration bullet) if a tool turn
 * follows it before the next user message; otherwise it's the "answer" bubble. */
function classifyTurn(turns: UiTurn[], i: number): TurnKind {
  const t = turns[i]!;
  if (t.role === 'user') return 'user';
  if (t.role === 'system') return 'system';
  if (t.role === 'tool') return 'tool';
  for (let j = i + 1; j < turns.length && turns[j]!.role !== 'user'; j++) {
    if (turns[j]!.role === 'tool') return 'reasoning';
  }
  return 'answer';
}

/** Whether tool activity preceded this turn in the current exchange — used to
 * place a "✓ 完成" marker at the end of the timeline, just before the answer. */
function hadToolActivityBefore(turns: UiTurn[], i: number): boolean {
  for (let j = i - 1; j >= 0 && turns[j]!.role !== 'user'; j--) {
    if (turns[j]!.role === 'tool') return true;
  }
  return false;
}

export function App() {
  const [turns, setTurns] = useState<UiTurn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [, setProgress] = useState<ProgressState | null>(null);
  const [pendingConfirms, setPendingConfirms] = useState<WriteConfirmReq[]>([]);
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [mode, setMode] = useState<'chat' | 'plan'>('chat');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PlanDecisionReq | null>(null);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [runStats, setRunStats] = useState<{
    step: number;
    promptTokens: number;
    completionTokens: number;
  } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [adapterUpdateNote, setAdapterUpdateNote] = useState<string | null>(null);
  // Header menu state machine. 'closed' = no overlay; 'menu' = dropdown
  // showing; any other value = a settings page is open. Click outside the
  // menu/page region drops back to 'closed'.
  const [view, setView] = useState<View>('closed');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logCfg, setLogCfgState] = useState<LogConfig>(() => getLogConfig());
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG);

  const messagesRef = useRef<HTMLDivElement>(null);
  // Mirror of `sessionId` for the chrome.runtime.onMessage listener (which
  // is registered once in useEffect and would otherwise capture a stale
  // closure). Updated by the effect just below.
  const sessionIdRef = useRef<string | null>(null);
  // Plan decisions the user already answered — ignore late re-sends (§10.19) so
  // a resolved card can't pop back up.
  const handledPlanDecisions = useRef<Set<string>>(new Set());
  // The live log stream (subscribeLog + LOG_ENTRY) used to setLogs on EVERY log
  // line, re-rendering the whole panel constantly — a render storm that thrashed
  // the plan-approval card's paint (and would loop outright with any render-time
  // log). `logs` only shows in the logs view, so accumulate ONLY while it's open;
  // on open we pull the SW buffer via requestLogs(). viewRef so the
  // once-registered listeners read the latest view. §10.21
  const viewRef = useRef<View>('closed');
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    viewRef.current = view;
    if (view === 'logs') void requestLogs();
  }, [view]);

  function eventBelongsToCurrentSession(eventSessionId: string | undefined): boolean {
    if (!eventSessionId) return true; // global event (no session scope)
    return sessionIdRef.current === eventSessionId;
  }

  /* mount: attach listeners, open keep-alive port */
  useEffect(() => {
    void requestLogs();
    const handler = (m: unknown) => onIncomingMessage(m as Message);
    chrome.runtime.onMessage.addListener(handler);
    const unsubLog = subscribeLog((e) => {
      if (viewRef.current === 'logs') setLogs((cur) => append(cur, e, 500));
    });
    // Pin the SW alive while the SidePanel is open. MV3 SWs are killed
    // after ~30s of no chrome.* activity, which would otherwise orphan a
    // long-running iteration (LLM thinking phases >30s with no chrome.*
    // activity → SW recycle → activeSessions vanish → the next
    // ASSISTANT_TURN arriving after wake-up is silently dropped). An open
    // chrome.runtime.Port keeps the SW pinned per MV3 spec. SW dies on
    // disconnect (panel close) — that's fine, the user isn't watching.
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: 'webchat-keepalive' });
    } catch {}
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      unsubLog();
      try {
        port?.disconnect();
      } catch {}
    };
  }, []);

  /* load LLM config */
  useEffect(() => {
    void loadLlmConfig().then(setLlmConfig);
  }, []);

  /* On open: silently re-install any marketplace adapter whose bundled source
   * drifted (sha256 mismatch) so the user always runs the latest fix without a
   * manual uninstall/reinstall. A brief toast reports what was updated. */
  useEffect(() => {
    void reconcileStaleAdapters().then((updated) => {
      if (updated.length === 0) return;
      setAdapterUpdateNote(`已自动更新 ${updated.length} 个市场 adapter:${updated.join('、')}`);
      setTimeout(() => setAdapterUpdateNote(null), 8000);
    });
  }, []);

  /* autoscroll on new turn */
  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [turns.length]);

  /* close menu dropdown on outside click. (Page overlay closes via its own
   * backdrop click — different model since the page is full-surface.) The
   * menu lives inside .menu-anchor; any click outside that subtree closes.
   * Listener attaches on next tick so the click that opened the menu doesn't
   * immediately re-close it. */
  useEffect(() => {
    if (view !== 'menu') return;
    function onDocClick(e: MouseEvent): void {
      const t = e.target as Element | null;
      if (t?.closest('.menu-anchor')) return;
      setView('closed');
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [view]);

  function onIncomingMessage(m: Message): void {
    if (!m || typeof m !== 'object') return;
    // Drop events that belong to a session we've already moved on from
    // (e.g. user clicked Stop then quickly "+ 新对话" — the old session's
    // delayed SESSION_DONE would otherwise pollute the fresh chat).
    const sid = (m as { sessionId?: string }).sessionId;
    switch (m.type) {
      case 'ASSISTANT_TURN':
      case 'ASSISTANT_TURN_PATCH':
      case 'RUN_STATS':
      case 'TOOL_TRACE':
      case 'SESSION_DONE':
      case 'SESSION_NOTICE':
      case 'ITERATION_PROGRESS':
      case 'WRITE_CONFIRM_REQ':
      case 'PLAN_UPDATED':
      case 'PLAN_DECISION_REQ':
        if (!eventBelongsToCurrentSession(sid)) return;
        break;
      default:
        break;
    }
    switch (m.type) {
      case 'ASSISTANT_TURN':
        onAssistantTurn(m as AssistantTurnEvt);
        break;
      case 'ASSISTANT_TURN_PATCH':
        setStreaming((m as AssistantTurnPatchEvt).text);
        break;
      case 'RUN_STATS': {
        const s = m as RunStatsEvt;
        setRunStats({
          step: s.step,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
        });
        break;
      }
      case 'TOOL_TRACE':
        onToolTrace(m as ToolTraceEvt);
        break;
      case 'SESSION_DONE':
        onSessionDone(m as SessionDoneEvt);
        break;
      case 'SESSION_NOTICE':
        onSessionNotice(m as SessionNoticeEvt);
        break;
      case 'ITERATION_PROGRESS':
        onIterationProgress(m as IterationProgressEvt);
        break;
      case 'WRITE_CONFIRM_REQ':
        onWriteConfirmReq(m as WriteConfirmReq);
        break;
      case 'PLAN_UPDATED':
        setPlan((m as PlanUpdatedEvt).plan);
        break;
      case 'PLAN_DECISION_REQ': {
        const req = m as PlanDecisionReq;
        // Dedup the SW's re-sends (§10.19): ignore one already decided, and keep
        // the current card (don't reset in-progress edits) on a repeat.
        if (handledPlanDecisions.current.has(req.decisionId)) break;
        setPendingPlan((cur) => (cur && cur.decisionId === req.decisionId ? cur : req));
        break;
      }
      case 'LOG_ENTRY':
        if (viewRef.current === 'logs')
          setLogs((cur) => append(cur, (m as LogEntryEvt).entry, 500));
        break;
      default:
        break;
    }
  }

  function onSessionNotice(m: SessionNoticeEvt): void {
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text: m.text,
        level: m.level === 'error' ? 'error' : 'info',
        ts: Date.now(),
      },
    ]);
  }

  function onIterationProgress(m: IterationProgressEvt): void {
    if (m.phase === 'completed') {
      setProgress(null);
    } else if (m.phase === 'injecting' || m.phase === 'awaiting') {
      setProgress({ iteration: m.iteration, phase: m.phase });
    } else if (m.phase === 'streaming') {
      setProgress({ iteration: -1, phase: 'streaming', textLen: m.textLen });
    }
  }

  function onWriteConfirmReq(m: WriteConfirmReq): void {
    setPendingConfirms((cur) => [...cur, m]);
  }

  function onDecideWrite(approved: boolean): void {
    setPendingConfirms((cur) => {
      const [first, ...rest] = cur;
      if (!first) return cur;
      const resp: WriteConfirmResp = {
        type: 'WRITE_CONFIRM_RESP',
        confirmId: first.confirmId,
        approved,
      };
      chrome.runtime.sendMessage(resp).catch(() => {});
      return rest;
    });
  }

  function onDecidePlan(decision: 'approve' | 'reject', editedSteps?: string[]): void {
    setPendingPlan((cur) => {
      if (!cur) return null;
      handledPlanDecisions.current.add(cur.decisionId);
      const resp: PlanDecisionResp = {
        type: 'PLAN_DECISION_RESP',
        decisionId: cur.decisionId,
        decision,
        editedSteps,
      };
      chrome.runtime.sendMessage(resp).catch(() => {});
      return null;
    });
  }

  function onAssistantTurn(m: AssistantTurnEvt): void {
    setStreaming(null); // the finalized turn replaces the streaming bubble
    setTurns((cur) => [
      ...cur,
      {
        role: 'assistant',
        text: m.cleanedText,
        rawText: m.rawText,
        reasoningText: m.reasoningText,
        commands: m.commands,
        iteration: m.iteration,
        ts: Date.now(),
      },
    ]);
  }

  function onToolTrace(m: ToolTraceEvt): void {
    setTurns((cur) => {
      const idx = cur.findIndex((t) => t.role === 'tool' && t.trace.id === m.trace.id);
      const next: UiTurn = { role: 'tool', trace: m.trace, ts: Date.now() };
      if (idx >= 0) {
        const copy = cur.slice();
        copy[idx] = next;
        return copy;
      }
      return [...cur, next];
    });
  }

  function onSessionDone(m: SessionDoneEvt): void {
    setRunning(false);
    setProgress(null);
    setStreaming(null);
    setRunStats(null);
    // Keep the sessionId binding across ALL end reasons — no_more_commands /
    // user_abort / checkpoint / error alike. The history is persisted in IDB, so
    // the user can just type again to CONTINUE the same session with full
    // context. (Previously a hard error dropped the binding and silently started
    // a fresh session — that's what looked like "继续把它当成了新会话".) The SW
    // takes over any stale active run on the next message, so this is safe. §10.20
    // A checkpoint already surfaced an explanatory SESSION_NOTICE inline, and
    // the session stays resumable ("继续"), so don't append a redundant system
    // line — just stop the spinner (handled above) and keep the binding.
    if (m.reason === 'checkpoint') return;
    const text =
      m.reason === 'user_abort'
        ? '已停止'
        : m.error
          ? `会话结束：${m.error}`
          : m.reason === 'no_more_commands'
            ? '回答完成'
            : `会话结束（${m.reason}）`;
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text,
        level: m.reason === 'error' ? 'error' : 'info',
        ts: Date.now(),
      },
    ]);
  }

  async function requestLogs(): Promise<void> {
    const req: RequestLogsReq = { type: 'REQUEST_LOGS' };
    try {
      const r = (await chrome.runtime.sendMessage(req)) as LogsResponse | undefined;
      if (r?.entries) setLogs(r.entries);
    } catch {}
  }

  async function onSend(): Promise<void> {
    const text = input.trim();
    if (!text) return;
    if (running) {
      // Steer: inject into the running session instead of starting a new turn.
      if (!sessionId) return;
      const req: SteerMessageReq = { type: 'STEER_MESSAGE', sessionId, text };
      void chrome.runtime.sendMessage(req).catch(() => {});
      setInput('');
      setTurns((cur) => [...cur, { role: 'user', text: `↪ ${text}`, ts: Date.now() }]);
      return;
    }
    // Reuse sessionId across follow-up messages so the SW can continue in
    // the same chat history. Only allocate a new one if we're starting fresh
    // (no prior session) or the previous one ended.
    const sid = sessionId ?? makeSessionId();
    setSessionId(sid);
    setRunning(true);
    setInput('');
    setProgress({ iteration: 0, phase: 'injecting' });
    setTurns((cur) => [...cur, { role: 'user', text, ts: Date.now() }]);
    const req: UserMessageReq = { type: 'USER_MESSAGE', sessionId: sid, text, mode };
    // Fire-and-forget: SW early-acks. All further progress arrives via
    // events (ITERATION_PROGRESS / ASSISTANT_TURN / SESSION_DONE / ...).
    chrome.runtime.sendMessage(req).catch((e) => {
      setRunning(false);
      setSessionId(null);
      setProgress(null);
      setTurns((cur) => [
        ...cur,
        {
          role: 'system',
          text: `发送失败：${e instanceof Error ? e.message : String(e)}`,
          level: 'error',
          ts: Date.now(),
        },
      ]);
    });
  }

  function onAbort(): void {
    // Clear progress + running immediately for instant visual feedback —
    // don't depend on a SW round-trip. SW will also fire SESSION_DONE
    // (reason: user_abort) which renders the "已停止" system message; we
    // don't append it here to avoid duplication.
    setProgress(null);
    setRunning(false);
    setPendingPlan(null);
    setStreaming(null);
    setRunStats(null);
    if (!sessionId) return;
    const req: AbortSessionReq = { type: 'ABORT_SESSION', sessionId };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }

  function onNewChat(): void {
    if (running) onAbort();
    setSessionId(null);
    setTurns([]);
    setProgress(null);
    setPlan(null);
    setPendingPlan(null);
    setStreaming(null);
    setRunStats(null);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void onSend();
    }
  }

  // API readiness: input gates on whether the user has configured an API key.
  const apiReady = !!llmConfig.apiKey;
  const apiLabel = llmConfig.model || llmConfig.provider;
  const inputBlocked = !apiReady;
  // Live "what's happening now" text for the ongoing indicator.
  const inProgressStep = plan?.steps.find((s) => s.status === 'in_progress');
  const activeText =
    inProgressStep?.activeForm ||
    inProgressStep?.title ||
    (mode === 'plan' ? '规划中…' : '执行中…');

  return (
    <>
      <header>
        <span class="brand-row">
          <span class="brand" title="WebChat Agent">
            <IconBrand size={22} />
          </span>
          <span
            class={`status-pill ${apiReady ? 'ok' : 'warn'}`}
            onClick={() => setView('backend')}
            title={apiReady ? '点击打开设置' : '点击配置 API Key'}
          >
            <span class="dot" />
            {apiReady ? apiLabel : 'API 未配置'}
          </span>
        </span>
        <span class="header-actions">
          <button class="ghost-btn round" title="开始一个新对话" onClick={onNewChat}>
            <IconPlus size={18} />
          </button>
          <span class="menu-anchor">
            <button
              class={`ghost-btn round ${view === 'menu' ? 'active' : ''}`}
              title="菜单"
              onClick={() => setView((v) => (v === 'menu' ? 'closed' : 'menu'))}
            >
              <IconMenu size={18} />
            </button>
            {view === 'menu' && <MenuDropdown onPick={(target) => setView(target)} />}
          </span>
        </span>
      </header>

      {adapterUpdateNote && (
        <div class="adapter-update-toast" onClick={() => setAdapterUpdateNote(null)}>
          <IconRefresh size={14} />
          <span>{adapterUpdateNote}</span>
        </div>
      )}

      <div class="messages" ref={messagesRef}>
        {turns.length === 0 && !running && <WelcomeCard />}
        {turns.map((t, i) => {
          const kind = classifyTurn(turns, i);
          return (
            <TurnView
              key={i}
              turn={t}
              kind={kind}
              showDone={kind === 'answer' && hadToolActivityBefore(turns, i)}
              onImage={setLightbox}
            />
          );
        })}
        {streaming !== null && (
          <div class="msg assistant">
            <Markdown text={streaming || '…'} />
          </div>
        )}
        {plan && plan.steps.length > 0 && <PlanChecklist plan={plan} />}
        {running && streaming === null && <ActiveHeader text={activeText} />}
        {pendingConfirms.length > 0 && (
          <WriteConfirmCard
            req={pendingConfirms[0]}
            queueLen={pendingConfirms.length}
            onDecide={onDecideWrite}
          />
        )}
      </div>

      {pendingPlan && (
        <>
          {/* Pinned over the conversation (NOT inside the scrollable message
           * list, where it sat off-screen below the fold — §10.22). The backdrop
           * dims the rest so the required approve/modify/cancel decision can't be
           * scrolled away or ignored. */}
          <div class="plan-pin-backdrop" />
          <div class="plan-pin">
            <RenderBoundary label="PlanApprovalCard">
              <PlanApprovalCard req={pendingPlan} onDecide={onDecidePlan} />
            </RenderBoundary>
          </div>
        </>
      )}

      <footer>
        {running && runStats && (
          <div class="run-stats">
            <span>步 {runStats.step}</span>
            <span>上下文 ~{fmtTok(runStats.promptTokens)} tok</span>
            <span>输出 ~{fmtTok(runStats.completionTokens)} tok</span>
          </div>
        )}
        <div class={`composer-card ${inputBlocked && !running ? 'disabled' : ''}`}>
          <textarea
            class="composer-input"
            placeholder={
              !apiReady
                ? '先在右上角菜单 → LLM 后端 填入 API Key…'
                : running
                  ? '插话纠偏…（不打断当前任务）'
                  : turns.length > 0
                    ? '回复…'
                    : '问我点什么，比如：帮我看看小红书首页最近有什么内容'
            }
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            disabled={inputBlocked}
            rows={1}
          />
          <div class="composer-bar">
            <div class="mode-anchor">
              <button
                class="mode-pill"
                onClick={() => setModeMenuOpen((o) => !o)}
                title="选择执行模式"
              >
                {mode === 'plan' ? <IconHand size={14} /> : <IconFastForward size={14} />}
                <span>{mode === 'plan' ? '先计划再执行' : '直接执行'}</span>
                <IconChevronDown size={13} class="mode-chev" />
              </button>
              {modeMenuOpen && (
                <>
                  <div class="mode-backdrop" onClick={() => setModeMenuOpen(false)} />
                  <div class="mode-menu">
                    <button
                      class="mode-opt"
                      onClick={() => {
                        setMode('plan');
                        setModeMenuOpen(false);
                      }}
                    >
                      <IconHand size={18} class="mode-opt-icon" />
                      <span class="mode-opt-text">
                        <span class="mode-opt-title">先计划再执行</span>
                        <span class="mode-opt-desc">
                          复杂任务先给出可审批的计划；简单任务直接开始。
                        </span>
                      </span>
                      {mode === 'plan' && <IconCheck size={16} class="mode-check" />}
                    </button>
                    <button
                      class="mode-opt"
                      onClick={() => {
                        setMode('chat');
                        setModeMenuOpen(false);
                      }}
                    >
                      <IconFastForward size={18} class="mode-opt-icon" />
                      <span class="mode-opt-text">
                        <span class="mode-opt-title">直接执行</span>
                        <span class="mode-opt-desc">不暂停审批直接做（写操作仍会二次确认）。</span>
                      </span>
                      {mode === 'chat' && <IconCheck size={16} class="mode-check" />}
                    </button>
                  </div>
                </>
              )}
            </div>
            <div class="composer-bar-right">
              {running ? (
                <>
                  {input.trim() && (
                    <button
                      class="send-btn"
                      onClick={onSend}
                      title="插话纠偏（不打断当前会话）"
                      aria-label="插话"
                    >
                      <IconArrowUp size={16} />
                    </button>
                  )}
                  <button
                    class="send-btn stop"
                    onClick={onAbort}
                    title="停止生成"
                    aria-label="停止"
                  >
                    <IconStop size={12} />
                  </button>
                </>
              ) : (
                <button
                  class="send-btn"
                  onClick={onSend}
                  disabled={!input.trim() || inputBlocked}
                  title="发送 (Enter)"
                  aria-label="发送"
                >
                  <IconArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
        <div class="hint">Enter 发送 · AI 可能出错，请核对重要信息 · {apiLabel || 'API'}</div>
      </footer>

      {/* Top-level menu pages. History owns its own overlay because it has a
       * sub-page (one session's detail). The other three are plain content,
       * wrapped in the standard PageOverlay (title + close X). */}
      {view === 'backend' && (
        <PageOverlay title={PAGE_LABELS.backend} onClose={() => setView('closed')}>
          <LlmBackendSection config={llmConfig} onSave={(c) => setLlmConfig(c)} />
        </PageOverlay>
      )}
      {view === 'adapters' && (
        <PageOverlay title={PAGE_LABELS.adapters} onClose={() => setView('closed')}>
          <AdaptersSection />
        </PageOverlay>
      )}
      {view === 'history' && (
        <HistoryPage
          currentSessionId={sessionId}
          onClose={() => setView('closed')}
          onOpen={async (id) => {
            try {
              const r = (await chrome.runtime.sendMessage({
                type: 'GET_SESSION',
                sessionId: id,
              } satisfies GetSessionReq)) as GetSessionResp | undefined;
              const s = (r?.session as SessionState | null) ?? null;
              if (!s) return;
              setSessionId(s.id);
              setTurns(historyToUiTurns(s.history));
              setPlan(s.plan ?? null);
              setProgress(null);
              setRunning(false);
              setView('closed');
            } catch {}
          }}
          onDelete={(id) => {
            const req: DeleteSessionReq = { type: 'DELETE_SESSION', sessionId: id };
            chrome.runtime.sendMessage(req).catch(() => {});
            if (id === sessionId) {
              setSessionId(null);
              setTurns([]);
              setProgress(null);
            }
          }}
        />
      )}
      {view === 'memory' && (
        <PageOverlay title={PAGE_LABELS.memory} onClose={() => setView('closed')}>
          <MemorySection />
        </PageOverlay>
      )}
      {view === 'logs' && (
        <PageOverlay title={PAGE_LABELS.logs} onClose={() => setView('closed')}>
          <LogsSection
            logs={logs}
            logCfg={logCfg}
            onChangeLogCfg={async (next) => {
              setLogCfgState((prev) => ({ ...prev, ...next }));
              await setLogConfig(next);
            }}
            onClear={() => setLogs([])}
          />
        </PageOverlay>
      )}
      {lightbox && (
        <div class="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="screenshot" />
        </div>
      )}
    </>
  );
}

/** Menu items as a flat lucide-icon + label list. The dropdown anchors to its
 * parent (`.menu-anchor`) — clicking outside the menu OR a menu item closes
 * it. Order from most-used to least: backend → adapters → history → logs. */
function MenuDropdown({ onPick }: { onPick: (target: View) => void }): preact.JSX.Element {
  return (
    <div class="menu-dropdown" role="menu">
      <button class="menu-item" role="menuitem" onClick={() => onPick('backend')}>
        <IconCog size={16} class="menu-icon" />
        <span>LLM 后端</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('adapters')}>
        <IconPuzzle size={16} class="menu-icon" />
        <span>Adapters</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('history')}>
        <IconClock size={16} class="menu-icon" />
        <span>历史会话</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('memory')}>
        <span class="menu-icon" style={{ width: 16, textAlign: 'center' }}>
          🧠
        </span>
        <span>记忆</span>
      </button>
      <button class="menu-item" role="menuitem" onClick={() => onPick('logs')}>
        <IconTerminal size={16} class="menu-icon" />
        <span>日志</span>
      </button>
    </div>
  );
}

/** Full-surface overlay that fades a backdrop on top of the chat panel and
 * slides a panel in from the right.
 *
 * Two header shapes by props:
 *  - Default (top-level menu page): title on the left, [X] on the right. No
 *    back arrow — the page has no parent to return to (Esc / backdrop click
 *    / X all close it).
 *  - Sub-page (drill-down, e.g. one session detail): pass `onBack` to put a
 *    ← arrow on the left that pops back to the parent page. Pass
 *    `rightActions` to render custom buttons (e.g. [打开] [删除]) instead of
 *    the default X.
 *
 * Esc always invokes `onClose` (or `onBack` for sub-pages — whichever the
 * caller wants to mean "leave this view"); backdrop click does the same. */
function PageOverlay({
  title,
  onClose,
  onBack,
  rightActions,
  children,
}: {
  title: string;
  onClose: () => void;
  onBack?: () => void;
  rightActions?: preact.ComponentChildren;
  children: preact.ComponentChildren;
}): preact.JSX.Element {
  // Sub-page Esc bubbles to its own back action; top-level Esc closes.
  const escTarget = onBack ?? onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') escTarget();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escTarget]);
  // Backdrop click: top-level page closes everything; sub-page just pops
  // back to its parent. Matches what Esc does on each.
  return (
    <div class="page-overlay" onClick={escTarget}>
      <div class="page" onClick={(e) => e.stopPropagation()}>
        <div class="page-header">
          {onBack && (
            <button class="ghost-btn round" onClick={onBack} aria-label="返回" title="返回">
              <IconChevronLeft size={18} />
            </button>
          )}
          <span class="page-title">{title}</span>
          <span class="page-actions">
            {rightActions ?? (
              <button class="ghost-btn round" onClick={onClose} aria-label="关闭" title="关闭">
                <IconX size={16} />
              </button>
            )}
          </span>
        </div>
        <div class="page-body">{children}</div>
      </div>
    </div>
  );
}

function LogsSection({
  logs,
  logCfg,
  onChangeLogCfg,
  onClear,
}: {
  logs: LogEntry[];
  logCfg: LogConfig;
  onChangeLogCfg: (next: Partial<LogConfig>) => Promise<void>;
  onClear: () => void;
}): preact.JSX.Element {
  return (
    <div class="logs-page">
      <div class="controls">
        <label class="toggle-row">
          <span>详细日志</span>
          <input
            type="checkbox"
            checked={logCfg.enabled}
            onChange={(e) =>
              void onChangeLogCfg({ enabled: (e.target as HTMLInputElement).checked })
            }
          />
        </label>
        <button class="btn sm outline" onClick={onClear} disabled={logs.length === 0}>
          清空 ({logs.length})
        </button>
      </div>
      <div class="log-viewer">
        {logs.length === 0 ? (
          <div class="empty">暂无日志</div>
        ) : (
          logs.slice(-200).map((e, i) => (
            <div key={i} class={`entry ${e.level}`}>
              <span class="ts">{new Date(e.ts).toLocaleTimeString()} </span>
              <span class="scope">[{e.scope}]</span> <span>{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Live "ongoing" indicator at the active edge of the timeline — a spinning
 * sparkle + the current high-level task (Claude-for-Chrome style). */
function ActiveHeader({ text }: { text: string }): preact.JSX.Element {
  return (
    <div class="tl-active-head">
      <IconSparkle size={18} class="tl-sparkle" />
      <span>{text}</span>
    </div>
  );
}

function WriteConfirmCard({
  req,
  queueLen,
  onDecide,
}: {
  req: WriteConfirmReq;
  queueLen: number;
  onDecide: (approved: boolean) => void;
}) {
  const argsJson = useMemo(() => {
    try {
      return JSON.stringify(req.args ?? {}, null, 2);
    } catch {
      return String(req.args);
    }
  }, [req.args]);
  return (
    <div class="write-confirm">
      <div class="title">⚠️ 写操作需要确认</div>
      <div class="tool-name">
        <code>{req.tool}</code>
      </div>
      {req.description && <div class="desc">{req.description}</div>}
      <pre class="args">{argsJson}</pre>
      {queueLen > 1 && <div class="queued">还有 {queueLen - 1} 个写操作排队等待</div>}
      <div class="actions">
        <button class="primary" onClick={() => onDecide(true)}>
          确认执行
        </button>
        <button class="secondary" onClick={() => onDecide(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

/** Long-term memory management page (R4): list + delete saved user facts. */
function MemorySection(): preact.JSX.Element {
  const [items, setItems] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = (await chrome.runtime.sendMessage({
          type: 'LIST_MEMORIES',
        } satisfies ListMemoriesReq)) as ListMemoriesResp | undefined;
        if (alive) setItems(r?.memories ?? []);
      } catch {
        if (alive) setItems([]);
      }
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);
  function del(id: string): void {
    void chrome.runtime
      .sendMessage({ type: 'DELETE_MEMORY', id } satisfies DeleteMemoryReq)
      .catch(() => {});
    setItems((cur) => cur.filter((m) => m.id !== id));
  }
  return (
    <div style={{ padding: '4px 2px', fontSize: 13 }}>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Agent 在对话里调用 remember 时记下的用户长期偏好 / 事实，每次会话开始时注入上下文。
      </p>
      {loading ? (
        <div style={{ opacity: 0.6 }}>加载中…</div>
      ) : items.length === 0 ? (
        <div style={{ opacity: 0.6 }}>还没有长期记忆。</div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {items.map((m) => (
            <li
              key={m.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '6px 8px',
                border: '1px solid rgba(127,127,127,0.2)',
                borderRadius: 6,
              }}
            >
              <span style={{ flex: 1 }}>{m.text}</span>
              <button
                class="ghost-btn"
                title="删除"
                onClick={() => del(m.id)}
                style={{ fontSize: 12 }}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Catch a render throw in `children` and show the error inline instead of
 * silently failing (a throw in PlanApprovalCard would otherwise leave the card
 * invisible and freeze the whole tree). Kept around the approval card — a
 * required interaction — so a future render bug surfaces visibly, not silently. */
class RenderBoundary extends Component<
  { label: string; children: preact.ComponentChildren },
  { err: string | null }
> {
  state = { err: null as string | null };
  static getDerivedStateFromError(err: unknown): { err: string } {
    return { err: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
  componentDidCatch(err: unknown): void {
    console.error('[webchat:panel] render error in', this.props.label, err);
  }
  render(): preact.ComponentChildren {
    if (this.state.err) {
      return (
        <div
          style={{
            border: '1px solid #c0392b',
            background: '#fdecea',
            color: '#900',
            borderRadius: 8,
            padding: 10,
            margin: '4px 0',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          ⚠️ {this.props.label} 渲染出错：{this.state.err}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Plan-approval card (Phase 2 plan mode). Mirrors WriteConfirmCard. Shows the
 * proposed goal + steps (editable, one per line) and approve / cancel. */
function PlanApprovalCard({
  req,
  onDecide,
}: {
  req: PlanDecisionReq;
  onDecide: (decision: 'approve' | 'reject', editedSteps?: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const original = req.plan.steps.map((s) => s.title);
  const [text, setText] = useState(original.join('\n'));
  const edited = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const changed = edited.length !== original.length || edited.some((l, i) => l !== original[i]);
  const sites = planSites([req.plan.goal ?? '', ...original].join(' '));
  return (
    <div class="plan-card">
      <div class="plan-card-head">
        <IconList size={16} />
        <span>计划</span>
      </div>
      <div class="plan-card-body">
        {req.plan.goal && <div class="plan-goal">{req.plan.goal}</div>}
        {sites.length > 0 && (
          <>
            <div class="plan-sec">涉及站点</div>
            <div class="plan-sites">
              {sites.map((s) => (
                <span key={s} class="plan-site">
                  <IconGlobe size={13} />
                  {s}
                </span>
              ))}
            </div>
          </>
        )}
        <div class="plan-sec">执行步骤</div>
        {editing ? (
          <textarea
            class="plan-edit"
            value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            rows={Math.max(3, edited.length)}
            title="每行一个步骤"
          />
        ) : (
          <ol class="plan-steps">
            {req.plan.steps.map((s, i) => (
              <li key={i}>
                <span class="plan-num">{i + 1}</span>
                <span>{s.title}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div class="plan-actions">
        {editing ? (
          <>
            <button
              class="plan-btn primary"
              disabled={edited.length === 0}
              onClick={() => onDecide('approve', changed ? edited : undefined)}
            >
              用修改后的计划执行
            </button>
            <button class="plan-btn" onClick={() => setEditing(false)}>
              返回
            </button>
          </>
        ) : (
          <>
            <button class="plan-btn primary" onClick={() => onDecide('approve')}>
              批准执行<span class="kbd">⏎</span>
            </button>
            <button class="plan-btn" onClick={() => setEditing(true)}>
              修改
            </button>
            <button class="plan-btn ghost" onClick={() => onDecide('reject')}>
              取消
            </button>
          </>
        )}
      </div>
      <div class="plan-foot">只会用上面列出的内容；访问其它站点 / 写操作前会再问你。</div>
    </div>
  );
}

/** Live plan/todo checklist (Phase 1). Re-renders in place on every PLAN_UPDATED
 * event. Inline-styled so it needs no CSS additions. */
function PlanChecklist({ plan }: { plan: PlanState }): preact.JSX.Element {
  const completed = plan.steps.filter((s) => s.status === 'completed').length;
  const skipped = plan.steps.filter((s) => s.status === 'skipped').length;
  const failed = plan.steps.filter((s) => s.status === 'failed').length;
  const extra = [skipped ? `${skipped} 跳过` : '', failed ? `${failed} 失败` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      style={{
        margin: '4px 0 10px',
        border: '1px solid rgba(127,127,127,0.25)',
        borderRadius: 8,
        padding: '8px 10px',
        background: 'rgba(127,127,127,0.06)',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, opacity: 0.85 }}>
        📋 计划 {completed}/{plan.steps.length}
        {extra ? ` (${extra})` : ''}
        {plan.goal ? ` · ${plan.goal}` : ''}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {plan.steps.map((s, i) => {
          // Truthful per-step state: done / skipped / failed / in_progress /
          // pending are each visually distinct. docs/agent-harness.md §10.15.
          const dim = s.status === 'completed' || s.status === 'skipped';
          const mark =
            s.status === 'completed'
              ? '✓'
              : s.status === 'skipped'
                ? '⊘'
                : s.status === 'failed'
                  ? '✗'
                  : s.status === 'in_progress'
                    ? '▸'
                    : '○';
          const label =
            s.status === 'in_progress' && s.activeForm
              ? s.activeForm
              : (s.status === 'skipped' || s.status === 'failed') && s.activeForm
                ? `${s.title} — ${s.activeForm}`
                : s.title;
          return (
            <li
              key={i}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                opacity: dim ? 0.55 : 1,
                color: s.status === 'failed' ? '#c0392b' : undefined,
                padding: '1px 0',
              }}
            >
              <span style={{ width: 14, flexShrink: 0 }}>{mark}</span>
              <span style={{ textDecoration: dim ? 'line-through' : 'none' }}>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WelcomeCard() {
  return (
    <div class="welcome">
      <h3>WebChat Agent</h3>
      <p>
        把任意聊天网页变成浏览器 Agent。你在这里输入指令，DeepSeek 在后台帮你思考，
        我们负责执行小红书等网站操作并把结果回传给它，最终把整理过的回答展示给你。
      </p>
      <ul>
        <li>看小红书首页：「看下小红书首页最近热门内容并总结」</li>
        <li>搜笔记：「帮我搜小红书上「Roborock 扫地机」的笔记，对比下口碑」</li>
        <li>看通知：「我的小红书最近有什么新评论？」</li>
      </ul>
    </div>
  );
}

function TurnView({
  turn,
  kind,
  showDone,
  onImage,
}: {
  turn: UiTurn;
  kind: TurnKind;
  showDone?: boolean;
  onImage?: (url: string) => void;
}) {
  if (turn.role === 'user') {
    return <div class="msg user">{turn.text}</div>;
  }
  if (turn.role === 'system') {
    if (turn.text === '回答完成') return null; // ✓ marker is rendered before the answer instead
    return <div class={`msg system ${turn.level === 'error' ? 'err' : ''}`}>{turn.text}</div>;
  }
  if (turn.role === 'tool') {
    return <TimelineToolRow trace={turn.trace} onImage={onImage} />;
  }
  if (kind === 'reasoning') {
    const reason = turn.text?.trim();
    // Most models emit empty content + tool_calls and put the actual rationale
    // ("why I'm calling this tool next") in reasoning_content → reasoningText.
    // Surface it in the timeline so the run reads as a clear chain of intent,
    // not a bare list of tool calls.
    const thinking = turn.reasoningText?.trim();
    if (!reason && !thinking) return null;
    return (
      <div class="tl-row reason">
        <span class="tl-gutter">
          <span class="tl-icon dot">
            <IconDot size={7} />
          </span>
        </span>
        <span class="tl-reason">
          {thinking && <div class="tl-thinking">{thinking}</div>}
          {reason && <Markdown text={reason} />}
        </span>
      </div>
    );
  }
  const looksLikeParseFailure =
    turn.commands.length === 0 &&
    !!turn.rawText &&
    /```[^\n`]*\r?\n[\s\S]*?\r?\n```/.test(turn.rawText);
  return (
    <>
      {showDone && <DoneRow />}
      <div class="msg assistant">
        {turn.reasoningText && (
          <details class="reasoning">
            <summary>思考过程</summary>
            <div class="body">{turn.reasoningText}</div>
          </details>
        )}
        <Markdown text={turn.text || '（无内容）'} />
        {turn.commands.length > 0 && (
          <details class="parsed-commands" open>
            <summary>
              已解析 {turn.commands.length} 个指令
              <span class="badges">
                {turn.commands.map((c, i) => (
                  <span key={i} class="badge">
                    {commandLabel(c)}
                  </span>
                ))}
              </span>
            </summary>
            <ol class="cmd-list">
              {turn.commands.map((c, i) => (
                <li key={i}>
                  <code>
                    {c.action}
                    {c.tool ? ` ${c.tool}` : ''}
                  </code>
                  {c.args && Object.keys(c.args).length > 0 && (
                    <pre>{JSON.stringify(c.args, null, 2)}</pre>
                  )}
                  {c.action === 'parse_error' && c.message && <pre>{c.message}</pre>}
                </li>
              ))}
            </ol>
          </details>
        )}
        {looksLikeParseFailure && (
          <div class="warn-banner">
            ⚠️ 回复里看起来有代码块但没解析出任何 agent-command。展开下方"原始回复"对照。
          </div>
        )}
        {turn.rawText && turn.rawText !== turn.text && (
          <details class="raw-text">
            <summary>原始回复（调试用）</summary>
            <pre>{turn.rawText}</pre>
          </details>
        )}
      </div>
    </>
  );
}

function commandLabel(c: import('../messages').ParsedCommand): string {
  if (c.action === 'execute_tool') return c.tool ?? 'execute_tool';
  return c.action;
}

/** Completion marker row at the end of an activity timeline. */
function DoneRow(): preact.JSX.Element {
  return (
    <div class="tl-row done">
      <span class="tl-gutter">
        <span class="tl-icon">
          <IconCheckCircle size={15} />
        </span>
      </span>
      <span class="tl-label">完成</span>
    </div>
  );
}

/** One tool call as an activity-timeline row (Claude-for-Chrome-style): semantic
 * icon + concise label + optional screenshot thumb; click to expand raw
 * args/result/error. */
function TimelineToolRow({
  trace,
  onImage,
}: {
  trace: ToolTrace;
  onImage?: (url: string) => void;
}): preact.JSX.Element {
  const [open, setOpen] = useState(false);
  const act = toolActivity(trace);
  const Icon = ACTIVITY_ICON[act.icon];
  const thumb = trace.result !== undefined ? screenshotDataUrl(trace.result) : null;
  const active = trace.status === 'started';
  const failed = trace.status === 'failed';
  const hasArgs = !!trace.args && Object.keys(trace.args).length > 0;
  const hasDetail = hasArgs || trace.result !== undefined || !!trace.error;
  return (
    <div class={`tl-row tool ${active ? 'active' : ''} ${failed ? 'failed' : ''}`}>
      <div
        class="tl-head"
        onClick={() => hasDetail && setOpen((o) => !o)}
        style={{ cursor: hasDetail ? 'pointer' : 'default' }}
      >
        <span class="tl-gutter">
          <span class="tl-icon">
            {active ? <IconSparkle size={15} class="tl-sparkle" /> : <Icon size={15} />}
          </span>
        </span>
        <span class="tl-main">
          <span class="tl-label">
            {act.label}
            {failed ? '（失败）' : ''}
          </span>
          {trace.tool && <span class="tl-tool">{trace.tool}</span>}
        </span>
        {thumb && (
          <img
            class="tl-thumb"
            src={thumb}
            alt="screenshot"
            onClick={(e) => {
              e.stopPropagation();
              onImage?.(thumb);
            }}
          />
        )}
        {hasDetail && <IconChevronDown size={13} class={`tl-chev ${open ? 'open' : ''}`} />}
      </div>
      {open && (
        <div class="tl-detail">
          {hasArgs && <CopyBox text={JSON.stringify(trace.args, null, 2)} />}
          {trace.error && <pre class="tl-err">{trace.error}</pre>}
          {trace.result !== undefined && !thumb && <CopyBox text={previewResult(trace.result)} />}
        </div>
      )}
    </div>
  );
}

/** A <pre> with a hover copy button in its top-right corner — used for the args
 * and result boxes in an expanded timeline step. */
function CopyBox({ text }: { text: string }): preact.JSX.Element {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }
  return (
    <div class="copybox">
      <button class="copybox-btn" title="复制" onClick={copy}>
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
      <pre>{text}</pre>
    </div>
  );
}

// Mirror the LLM-input cap in src/agent/{api-engine,system-prompt}.ts so the
// SidePanel shows ≥ what the model actually received. Keep in sync if either
// engine bumps its `MAX_TOOL_RESULT_CHARS`.
const PREVIEW_MAX_CHARS = 64_000;

function previewResult(r: unknown): string {
  try {
    const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    return s.length > PREVIEW_MAX_CHARS
      ? s.slice(0, PREVIEW_MAX_CHARS) + `\n…[truncated ${s.length - PREVIEW_MAX_CHARS}]`
      : s;
  } catch {
    return String(r);
  }
}

/** Multi-profile LLM backend manager.
 *
 * Two view states:
 *   - 'list' (default): status card + every saved profile as a card with
 *     「切换 / 编辑 / 删除」 + a "+ 新建配置" button.
 *   - editing (when `editing !== null`): the form, prefilled either with a
 *     blank new profile or an existing profile being edited.
 *
 * Source of truth is the chrome.storage profile store; this component re-loads
 * it after every mutation and pushes the **active** profile up to the parent
 * via `onSave` so the topbar status pill stays current. */
function LlmBackendSection({
  config: _config,
  onSave,
}: {
  config: LlmConfig;
  onSave: (c: LlmConfig) => void;
}) {
  const [store, setStore] = useState<LlmProfileStore>({ profiles: [], slots: {} });
  const [loading, setLoading] = useState(true);
  /** null = list view, 'new' = create form, profile = edit form prefilled. */
  const [editing, setEditing] = useState<LlmProfile | 'new' | null>(null);

  async function refresh(): Promise<void> {
    const s = await loadProfiles();
    setStore(s);
    setLoading(false);
    onSave(await loadLlmConfig());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleSetSlot(cap: Capability, id: string | null): Promise<void> {
    // Never let the user un-assign the required orchestrator while profiles exist.
    if (cap === 'primary' && !id && store.profiles.length > 0) return;
    await setSlot(cap, id);
    await refresh();
  }

  async function handleDelete(p: LlmProfile): Promise<void> {
    if (!confirm(`删除配置「${p.label}」?这无法撤销。`)) return;
    await deleteProfile(p.id);
    await refresh();
  }

  async function handleSave(profile: LlmProfile): Promise<void> {
    // upsertProfile auto-assigns the primary slot when none is set yet (the
    // first profile), so a fresh user is runnable without touching 模型分工.
    await upsertProfile(profile);
    setEditing(null);
    await refresh();
  }

  if (editing !== null) {
    const isNew = editing === 'new';
    const blank: LlmProfile = {
      id: newProfileId(),
      label: '',
      provider: DEFAULT_CONFIG.provider,
      baseUrl: DEFAULT_CONFIG.baseUrl,
      apiKey: '',
      model: DEFAULT_CONFIG.model,
    };
    return (
      <ProfileEditForm
        initial={isNew ? blank : (editing as LlmProfile)}
        isNew={isNew}
        onSave={(p) => handleSave(p)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const primary = store.profiles.find((p) => p.id === store.slots.primary);
  const ready = !!primary?.apiKey;
  const slotShort: Record<Capability, string> = { primary: '主', vision: '视觉', image: '图像' };
  const slotsForProfile = (id: string): string[] =>
    CAPABILITIES.filter((c) => store.slots[c.id] === id).map((c) => slotShort[c.id]);

  return (
    <>
      <div class="status-card">
        <span class={`dot ${ready ? '' : 'warn'}`} />
        <div style="flex:1;min-width:0">
          <div class="label">主模型</div>
          <div class="value">{primary ? primary.label : '未指派'}</div>
          {primary && (
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">
              {providerById(primary.provider)?.label ?? primary.provider} ·{' '}
              {primary.model || '(未填 model)'}
            </div>
          )}
        </div>
      </div>

      {store.profiles.length > 0 && (
        <div class="section">
          <h4>模型分工</h4>
          <p class="section-hint">
            给每个能力指派一个模型。一个模型可担多职(如多模态模型既当主模型又做视觉)。未配置的能力,任务需要时助手会提示你来这里添加。
          </p>
          {CAPABILITIES.map((cap) => (
            <div class="field" key={cap.id}>
              <label>
                {cap.label}
                {cap.required && <span style="color:var(--warn)"> *</span>}
              </label>
              <select
                value={store.slots[cap.id] ?? ''}
                onChange={(e) =>
                  void handleSetSlot(cap.id, (e.target as HTMLSelectElement).value || null)
                }
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px"
              >
                {/* The required primary keeps a placeholder only until one is
                    picked; once set it can be reassigned but not cleared. */}
                {(!cap.required || !store.slots[cap.id]) && (
                  <option value="" disabled={cap.required}>
                    {cap.required ? '请选择…' : '未配置'}
                  </option>
                )}
                {store.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span class="field-hint">{cap.hint}</span>
            </div>
          ))}
        </div>
      )}

      <div class="section">
        <h4>
          API Keys
          {store.profiles.length > 0 && <span class="muted"> · {store.profiles.length} 个</span>}
        </h4>
        <p class="section-hint">
          保存多套 key,在上面「模型分工」里指派各能力。Key 仅存于本机 chrome.storage。
        </p>
        {loading ? (
          <div style="color:var(--muted);font-size:13px">加载中…</div>
        ) : store.profiles.length === 0 ? (
          <div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;border:1px dashed var(--border);border-radius:10px">
            还没保存任何 API Key。点下方「+ 新建配置」开始。
          </div>
        ) : (
          <div class="profile-list">
            {store.profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                slots={slotsForProfile(p.id)}
                onEdit={() => setEditing(p)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
        <div style="margin-top:14px">
          <button class="btn primary full" onClick={() => setEditing('new')}>
            + 新建配置
          </button>
        </div>
      </div>
    </>
  );
}

function ProfileCard({
  profile,
  slots,
  onEdit,
  onDelete,
}: {
  profile: LlmProfile;
  slots: string[];
  onEdit: () => void;
  onDelete: () => void;
}): preact.JSX.Element {
  const providerLabel = providerById(profile.provider)?.label ?? profile.provider;
  return (
    <div class={`profile-card${slots.length ? ' active' : ''}`}>
      <div class="profile-card-main">
        <div class="profile-card-head">
          {slots.map((s) => (
            <span key={s} class="active-badge">
              {s}
            </span>
          ))}
          <span class="profile-card-label">{profile.label}</span>
        </div>
        <div class="profile-card-meta">
          {providerLabel} · {profile.model || '(未填 model)'}
        </div>
        <div class="profile-card-key">{maskApiKey(profile.apiKey)}</div>
      </div>
      <div class="profile-card-actions">
        <button class="btn sm outline" onClick={onEdit} title="修改这条配置">
          编辑
        </button>
        <button class="btn sm outline danger" onClick={onDelete} title="删除这条配置">
          删除
        </button>
      </div>
    </div>
  );
}

function maskApiKey(key: string): string {
  if (!key) return '(未填 key)';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}`;
}

function ProfileEditForm({
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  initial: LlmProfile;
  isNew: boolean;
  onSave: (p: LlmProfile) => void;
  onCancel: () => void;
}): preact.JSX.Element {
  const [label, setLabel] = useState<string>(initial.label);
  const [provider, setProvider] = useState<string>(initial.provider);
  const [baseUrl, setBaseUrl] = useState<string>(initial.baseUrl);
  const [apiKey, setApiKey] = useState<string>(initial.apiKey);
  const [model, setModel] = useState<string>(initial.model);

  function pickProvider(id: string): void {
    setProvider(id);
    const p = providerById(id);
    if (p && id !== 'custom') {
      setBaseUrl(p.baseUrl);
      setModel(p.defaultModel);
    }
  }

  const trimmed: LlmConfig = {
    provider,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
  };
  const effectiveLabel = label.trim() || autoLabel(trimmed);
  const canSave = !!trimmed.apiKey && !!trimmed.baseUrl && !!trimmed.model;

  function save(): void {
    onSave({ id: initial.id, label: effectiveLabel, ...trimmed });
  }

  return (
    <>
      <div class="section">
        <h4>{isNew ? '新建配置' : '编辑配置'}</h4>
        <p class="section-hint">
          任何 OpenAI 兼容 /chat/completions endpoint 都可。Key 仅存于本机 chrome.storage。
        </p>
        <div class="field">
          <label>标签</label>
          <input
            value={label}
            placeholder={autoLabel(trimmed)}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">不填会自动用「供应商 · model」生成,便于在列表里区分。</span>
        </div>
        <div class="field">
          <label>供应商</label>
          <div class="pill-row">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                class={`pill ${provider === p.id ? 'selected' : ''}`}
                onClick={() => pickProvider(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div class="field">
          <label>Base URL</label>
          <input
            value={baseUrl}
            placeholder="https://api.deepseek.com"
            onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            placeholder="sk-..."
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label>Model</label>
          <input
            value={model}
            placeholder="deepseek-chat"
            onInput={(e) => setModel((e.target as HTMLInputElement).value)}
          />
          <span class="field-hint">
            按 endpoint 实际支持的模型名填(例:deepseek-chat / gpt-4o / glm-4.6v / cogview-4)。
            模型用于什么(主模型 / 视觉 / 图像生成)在「模型分工」里指派,不在这里设。
          </span>
        </div>
      </div>

      <div class="form-footer">
        <div style="display:flex;gap:8px">
          <button class="btn outline" onClick={onCancel} style="flex:1">
            取消
          </button>
          <button class="btn primary" disabled={!canSave} onClick={save} style="flex:1">
            {isNew ? '创建并启用' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

/** History — two-level navigation:
 *   - List page (default): every persisted session as a clean card. Click → drill.
 *   - Detail sub-page: when `selectedId` is set, render the same PageOverlay
 *     but with `onBack` (← arrow) and `rightActions` ([打开]/[删除]/[恢复]) in
 *     the header. Backdrop click + Esc pop back to the list, not to the
 *     chat — that's what `onBack` controls in PageOverlay.
 *
 * Detail data is fetched on click (`loadDetail`) — the list summaries don't
 * carry full turn history. Refetch on every drill so updates land. */
function HistoryPage({
  currentSessionId,
  onClose,
  onOpen,
  onDelete,
}: {
  currentSessionId: string | null;
  onClose: () => void;
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}): preact.JSX.Element {
  const [list, setList] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionState | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const req: ListSessionsReq = { type: 'LIST_SESSIONS' };
      const r = (await chrome.runtime.sendMessage(req)) as ListSessionsResp | undefined;
      setList(r?.sessions ?? []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Auto-refresh when SESSION_DONE / ASSISTANT_TURN happens — those are
    // the moments list contents change.
    const handler = (m: unknown) => {
      const t = (m as { type?: string })?.type;
      if (t === 'SESSION_DONE' || t === 'ASSISTANT_TURN') {
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  async function drillTo(id: string): Promise<void> {
    setSelectedId(id);
    setDetail(null);
    try {
      const req: GetSessionReq = { type: 'GET_SESSION', sessionId: id };
      const r = (await chrome.runtime.sendMessage(req)) as GetSessionResp | undefined;
      setDetail((r?.session as SessionState | null) ?? null);
    } catch {
      setDetail(null);
    }
  }

  function backToList(): void {
    setSelectedId(null);
    setDetail(null);
  }

  // ── Sub-page: one session detail ──
  if (selectedId) {
    const summary = list.find((s) => s.id === selectedId);
    const isCurrent = selectedId === currentSessionId;
    const title = summary?.preview?.trim() || '会话详情';

    return (
      <PageOverlay
        title={title}
        onClose={onClose}
        onBack={backToList}
        rightActions={
          <>
            <button
              class="btn sm outline"
              disabled={isCurrent}
              title={isCurrent ? '已经是当前会话' : '把这条会话加载到主聊天面板继续(保留上下文)'}
              onClick={() => onOpen(selectedId)}
            >
              打开
            </button>
            <button
              class="btn sm danger"
              disabled={isCurrent}
              title={isCurrent ? '不能删除正在进行的会话,先「+ 新对话」' : '永久删除这条会话'}
              onClick={() => {
                if (confirm('确认删除这条历史会话?')) {
                  onDelete(selectedId);
                  backToList();
                }
              }}
            >
              删除
            </button>
          </>
        }
      >
        {detail === null ? (
          <div class="hist-empty">加载详情中...</div>
        ) : (
          <SessionDetailView summary={summary} session={detail} isCurrent={isCurrent} />
        )}
      </PageOverlay>
    );
  }

  // ── List page ──
  return (
    <PageOverlay
      title={PAGE_LABELS.history}
      onClose={onClose}
      rightActions={
        <>
          <button
            class="ghost-btn round"
            title="刷新"
            onClick={() => void refresh()}
            aria-label="刷新"
          >
            <IconRefresh size={16} />
          </button>
          <button class="ghost-btn round" onClick={onClose} aria-label="关闭" title="关闭">
            <IconX size={16} />
          </button>
        </>
      }
    >
      {loading ? (
        <div class="hist-empty">加载中...</div>
      ) : list.length === 0 ? (
        <div class="hist-empty">还没有历史会话</div>
      ) : (
        <ul class="history-list">
          {list.map((s) => {
            const isCurrent = s.id === currentSessionId;
            return (
              <li key={s.id}>
                <button
                  class={`session-card ${isCurrent ? 'current' : ''}`}
                  onClick={() => void drillTo(s.id)}
                >
                  <div class="row">
                    <span class={`hist-badge ${badgeClass(s.status)}`}>{badgeText(s.status)}</span>
                    <span class="time">{relativeTime(s.updatedAt)}</span>
                  </div>
                  <div class="preview">{s.preview || '(无内容)'}</div>
                  <div class="meta">
                    iter {s.iterations} · {s.turnCount} 轮消息 · {s.toolCallCount} 次工具
                    {isCurrent && <span class="current-tag"> · 当前会话</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PageOverlay>
  );
}

function SessionDetailView({
  summary,
  session,
  isCurrent,
}: {
  summary: SessionSummary | undefined;
  session: SessionState;
  isCurrent: boolean;
}): preact.JSX.Element {
  const status = summary?.status ?? 'idle';
  return (
    <div class="session-detail">
      <div class="meta-row">
        <span class={`hist-badge ${badgeClass(status)}`}>{badgeText(status)}</span>
        <span>iter {summary?.iterations ?? '?'}</span>
        <span>·</span>
        <span>{summary?.turnCount ?? session.history.length} 轮消息</span>
        <span>·</span>
        <span>{summary?.toolCallCount ?? '?'} 次工具调用</span>
        {isCurrent && (
          <span class="current-tag" style="color:var(--accent);font-weight:600">
            · 当前会话
          </span>
        )}
      </div>

      <div class="turns-heading">消息历史</div>
      <div class="turns">
        {session.history.length === 0 ? (
          <div class="hist-empty">(没有消息)</div>
        ) : (
          session.history.map((t, i) => <DetailTurn key={i} turn={t} />)
        )}
      </div>
    </div>
  );
}

function DetailTurn({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return <div class="hist-turn user">{turn.text}</div>;
  }
  if (turn.role === 'assistant') {
    return (
      <div class="hist-turn assistant">
        <Markdown text={turn.cleanedText || '（无内容）'} />
        {turn.commands.length > 0 && (
          <div class="hist-cmd-list">
            {turn.commands.map((c, i) => (
              <span key={i} class="hist-cmd-badge">
                {c.action === 'execute_tool' ? c.tool : c.action}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  // tool_trace
  const t = turn.trace;
  return (
    <div class="hist-turn tool">
      <span
        class={`hist-badge ${t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'err' : 'pending'}`}
      >
        {t.action}
        {t.tool ? ` ${t.tool}` : ''}
      </span>
      {t.error && <pre class="hist-err">{t.error}</pre>}
    </div>
  );
}

function badgeClass(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return 'pending';
    case 'error':
      return 'err';
    case 'aborted':
      return 'muted';
    default:
      return 'ok';
  }
}

function badgeText(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'error':
      return '出错';
    case 'aborted':
      return '已终止';
    case 'idle':
      return '已完成';
    default:
      return status;
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return new Date(ts).toLocaleDateString();
}

function append<T>(arr: T[], item: T, max: number): T[] {
  const next = [...arr, item];
  return next.length > max ? next.slice(-max) : next;
}

/** Translate the persisted session.history (Turn[]) into the SidePanel's
 * rendering shape (UiTurn[]). The only fiddly bit is the role name:
 * SessionState uses `'tool_trace'` while UiTurn uses `'tool'`. */
function historyToUiTurns(history: Turn[]): UiTurn[] {
  return history.map((t): UiTurn => {
    if (t.role === 'user') {
      return { role: 'user', text: t.text, ts: t.ts };
    }
    if (t.role === 'assistant') {
      return {
        role: 'assistant',
        text: t.cleanedText,
        reasoningText: t.reasoningText,
        commands: t.commands,
        iteration: t.iteration,
        ts: t.ts,
      };
    }
    // tool_trace → 'tool'
    return { role: 'tool', trace: t.trace, ts: t.ts };
  });
}
