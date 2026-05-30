import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Markdown } from './Markdown';
import { AdaptersSection } from './Adapters';
import type { UiTurn } from './types';
import {
  type AbortSessionReq,
  type AssistantTurnEvt,
  type ChatbotBusyEvt,
  type ChatbotStreamingEvt,
  type ChatbotTabStatusEvt,
  type DeleteSessionReq,
  type DiscardSessionReq,
  type EnsureChatbotTabReq,
  type GetSessionReq,
  type GetSessionResp,
  type IterationProgressEvt,
  type ListSessionsReq,
  type ListSessionsResp,
  type LogEntryEvt,
  type LogsResponse,
  type Message,
  type RequestLogsReq,
  type ResumeSessionReq,
  type SessionDoneEvt,
  type SessionNoticeEvt,
  type SessionPausedEvt,
  type SessionSummary,
  type ToolTrace,
  type ToolTraceEvt,
  type UserMessageReq,
  type WriteConfirmReq,
  type WriteConfirmResp,
} from '../connectors/messages';
import type { SessionState, Turn } from '../agent/session';
import type { LogEntry, LogConfig } from '../runtime/log';
import { getLogConfig, setLogConfig, subscribeLog } from '../runtime/log';
import { makeSessionId } from '../agent/session';
import {
  CHATBOTS,
  DEFAULT_CONFIG,
  PROVIDERS,
  loadLlmConfig,
  providerById,
  saveLlmConfig,
  type ChatbotId,
  type LlmConfig,
} from '../config/llm-config';

const DEEPSEEK_URL = 'https://chat.deepseek.com';

interface ProgressState {
  iteration: number;
  phase: 'injecting' | 'awaiting' | 'streaming';
  textLen?: number;
}

interface PausedState {
  reason: 'tab_closed' | 'tab_navigated_away' | 'conv_mismatch' | 'tab_not_ready';
  conversationUrl: string | null;
  pendingPromptPreview?: string;
}

export function App() {
  const [turns, setTurns] = useState<UiTurn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [paused, setPaused] = useState<PausedState | null>(null);
  const [pendingConfirms, setPendingConfirms] = useState<WriteConfirmReq[]>([]);
  const [tabStatus, setTabStatus] = useState<ChatbotTabStatusEvt | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logCfg, setLogCfgState] = useState<LogConfig>(() => getLogConfig());
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_CONFIG);

  const messagesRef = useRef<HTMLDivElement>(null);
  // Mirror of `sessionId` for the chrome.runtime.onMessage listener (which
  // is registered once in useEffect and would otherwise capture a stale
  // closure). Updated by the effect just below.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  function eventBelongsToCurrentSession(eventSessionId: string | undefined): boolean {
    if (!eventSessionId) return true; // global event (no session scope)
    return sessionIdRef.current === eventSessionId;
  }

  /* mount: ensure tab status, attach listeners, open keep-alive port */
  useEffect(() => {
    void requestEnsureTab();
    void requestLogs();
    const handler = (m: unknown) => onIncomingMessage(m as Message);
    chrome.runtime.onMessage.addListener(handler);
    const unsubLog = subscribeLog((e) => setLogs((cur) => append(cur, e, 500)));
    // Pin the SW alive while the SidePanel is open. MV3 SWs are killed
    // after ~30s of no chrome.* activity, which would otherwise orphan a
    // long-running orchestrator iteration (e.g., DeepSeek thinking for
    // 90s) — pendingResponses / activeSessions would vanish and the next
    // CHATBOT_RESPONSE arriving after wake-up would be dropped as
    // "unmatched". An open chrome.runtime.Port keeps the SW pinned per
    // MV3 spec. SW dies on disconnect (panel close) — that's fine, the
    // user isn't watching anyway.
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

  /* load LLM backend config (mode / provider / chatbot) */
  useEffect(() => {
    void loadLlmConfig().then(setLlmConfig);
  }, []);

  /* autoscroll on new turn */
  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [turns.length]);

  function onIncomingMessage(m: Message): void {
    if (!m || typeof m !== 'object') return;
    // Drop events that belong to a session we've already moved on from
    // (e.g. user clicked Stop then quickly "+ 新对话" — the old session's
    // delayed SESSION_DONE would otherwise pollute the fresh chat).
    const sid = (m as { sessionId?: string }).sessionId;
    switch (m.type) {
      case 'ASSISTANT_TURN':
      case 'TOOL_TRACE':
      case 'SESSION_DONE':
      case 'SESSION_PAUSED':
      case 'SESSION_NOTICE':
      case 'ITERATION_PROGRESS':
      case 'CHATBOT_STREAMING':
      case 'CHATBOT_BUSY':
      case 'WRITE_CONFIRM_REQ':
        if (!eventBelongsToCurrentSession(sid)) return;
        break;
      default:
        break;
    }
    switch (m.type) {
      case 'ASSISTANT_TURN':
        onAssistantTurn(m as AssistantTurnEvt);
        break;
      case 'TOOL_TRACE':
        onToolTrace(m as ToolTraceEvt);
        break;
      case 'SESSION_DONE':
        onSessionDone(m as SessionDoneEvt);
        break;
      case 'SESSION_PAUSED':
        onSessionPaused(m as SessionPausedEvt);
        break;
      case 'SESSION_NOTICE':
        onSessionNotice(m as SessionNoticeEvt);
        break;
      case 'ITERATION_PROGRESS':
        onIterationProgress(m as IterationProgressEvt);
        break;
      case 'CHATBOT_STREAMING':
        onChatbotStreaming(m as ChatbotStreamingEvt);
        break;
      case 'CHATBOT_TAB_STATUS':
        setTabStatus(m as ChatbotTabStatusEvt);
        break;
      case 'CHATBOT_BUSY':
        onChatbotBusy(m as ChatbotBusyEvt);
        break;
      case 'WRITE_CONFIRM_REQ':
        onWriteConfirmReq(m as WriteConfirmReq);
        break;
      case 'LOG_ENTRY':
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

  function onChatbotBusy(m: ChatbotBusyEvt): void {
    const seconds = Math.round(m.nextRetryInMs / 1000);
    const prefix = m.reason === 'stopped' ? `DeepSeek 生成被中止 (Stopped)` : `DeepSeek 服务繁忙`;
    const verb = m.reason === 'stopped' ? '点 Regenerate 重试' : '重试';
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text: `${prefix}，第 ${m.retryCount}/${m.maxRetries} 次${verb}将在 ${seconds} 秒后发起…`,
        level: 'info',
        ts: Date.now(),
      },
    ]);
  }

  function onIterationProgress(m: IterationProgressEvt): void {
    if (m.phase === 'completed') {
      setProgress(null);
    } else if (m.phase === 'injecting' || m.phase === 'awaiting') {
      setProgress({ iteration: m.iteration, phase: m.phase });
    }
  }

  function onChatbotStreaming(m: ChatbotStreamingEvt): void {
    setProgress({ iteration: -1, phase: 'streaming', textLen: m.textLen });
  }

  function onSessionPaused(m: SessionPausedEvt): void {
    setRunning(false);
    setProgress(null);
    setPaused({
      reason: m.reason,
      conversationUrl: m.conversationUrl,
      pendingPromptPreview: m.pendingPromptPreview,
    });
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

  function onAssistantTurn(m: AssistantTurnEvt): void {
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
    setPaused(null);
    // NOTE: deliberately NOT clearing sessionId on 'no_more_commands' —
    // follow-up messages stay in the same DeepSeek conversation so the
    // chatbot keeps context. On 'error' / 'user_abort' we drop the
    // binding since the session ended unhealthy and the user should
    // start fresh.
    if (m.reason === 'error') setSessionId(null);
    // user_abort: keep sessionId so a follow-up still continues in the
    // same DeepSeek conv (user just wanted to stop this turn, not the
    // whole session).
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

  async function requestEnsureTab(): Promise<void> {
    const req: EnsureChatbotTabReq = { type: 'ENSURE_CHATBOT_TAB', chatbot: 'deepseek' };
    try {
      const r = (await chrome.runtime.sendMessage(req)) as ChatbotTabStatusEvt | undefined;
      if (r) setTabStatus(r);
    } catch {}
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
    if (!text || running || paused) return;
    // Reuse sessionId across follow-up messages so the SW can continue in
    // the same DeepSeek conversation. Only allocate a new one if we're
    // starting fresh (no prior session) or the previous one ended.
    const sid = sessionId ?? makeSessionId();
    setSessionId(sid);
    setRunning(true);
    setInput('');
    setProgress({ iteration: 0, phase: 'injecting' });
    setTurns((cur) => [...cur, { role: 'user', text, ts: Date.now() }]);
    const req: UserMessageReq = { type: 'USER_MESSAGE', sessionId: sid, text };
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
    if (!sessionId) return;
    const req: AbortSessionReq = { type: 'ABORT_SESSION', sessionId };
    void chrome.runtime.sendMessage(req).catch(() => {});
  }

  function onResume(): void {
    if (!sessionId) return;
    const req: ResumeSessionReq = { type: 'RESUME_SESSION', sessionId };
    setPaused(null);
    setRunning(true);
    setProgress({ iteration: 0, phase: 'injecting' });
    chrome.runtime.sendMessage(req).catch((e) => {
      setRunning(false);
      setProgress(null);
      setTurns((cur) => [
        ...cur,
        {
          role: 'system',
          text: `恢复失败：${e instanceof Error ? e.message : String(e)}`,
          level: 'error',
          ts: Date.now(),
        },
      ]);
    });
  }

  function onDiscard(): void {
    if (!sessionId) return;
    const req: DiscardSessionReq = { type: 'DISCARD_SESSION', sessionId };
    chrome.runtime.sendMessage(req).catch(() => {});
    setPaused(null);
    setRunning(false);
    setSessionId(null);
    setProgress(null);
  }

  function onNewChat(): void {
    if (running) {
      // Abort the current run first so the SW doesn't hold the tab.
      onAbort();
    }
    setSessionId(null);
    setTurns([]);
    setProgress(null);
    setPaused(null);
    // Re-query tab status — after an error / abort the badge may be holding
    // a stale "未就绪" from a transient state. Force the SW to re-broadcast
    // the current best known tab (prefers any logged-in one over the
    // freshly-opened-but-not-ready one).
    void requestEnsureTab();
  }

  function onOpenDeepseek(): void {
    void chrome.tabs.create({ url: DEEPSEEK_URL }).then(() => {
      // Polling until connector announces ready.
      const t = setInterval(async () => {
        await requestEnsureTab();
        if (tabStatus?.ready) clearInterval(t);
      }, 1500);
      setTimeout(() => clearInterval(t), 60_000);
    });
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void onSend();
    }
  }

  const statusKind = useMemo<'ok' | 'warn' | 'err'>(() => {
    if (!tabStatus || tabStatus.tabId === null) return 'err';
    if (!tabStatus.ready) return 'warn';
    return 'ok';
  }, [tabStatus]);
  const statusText = useMemo(() => {
    if (!tabStatus || tabStatus.tabId === null) return 'DeepSeek 未连接';
    if (!tabStatus.ready) return 'DeepSeek 未就绪';
    return 'DeepSeek 已就绪';
  }, [tabStatus]);

  // Backend-readiness derivations. In api mode there's no DeepSeek tab — the
  // input gates on whether an API key is configured instead.
  const isApiMode = llmConfig.mode === 'api';
  const apiReady = llmConfig.mode === 'api' && !!llmConfig.apiKey;
  const apiLabel = llmConfig.mode === 'api' ? llmConfig.model || llmConfig.provider : '';
  const inputBlocked = !!paused || (isApiMode ? !apiReady : statusKind === 'err');

  return (
    <>
      <header>
        <span class="title">WebChat Agent</span>
        {isApiMode ? (
          <span
            class={`status-pill ${apiReady ? 'ok' : 'warn'}`}
            onClick={() => setShowDrawer(true)}
            title="API 模式 · 点击打开设置"
          >
            <span class="dot" />
            {apiReady ? `API · ${apiLabel}` : 'API 未配置'}
          </span>
        ) : (
          <span
            class={`status-pill ${statusKind}`}
            onClick={statusKind === 'err' ? onOpenDeepseek : () => void requestEnsureTab()}
            title={statusKind === 'err' ? '点击打开 chat.deepseek.com' : '点击刷新状态'}
          >
            <span class="dot" />
            {statusText}
          </span>
        )}
        <span class="header-actions">
          <button
            class="icon-btn"
            title="开始一个新对话（结束当前对话，DeepSeek 会换新的 conversation）"
            onClick={onNewChat}
          >
            + 新对话
          </button>
          <button class="icon-btn" title="设置 / 日志" onClick={() => setShowDrawer((v) => !v)}>
            ⚙
          </button>
        </span>
      </header>

      <div class="messages" ref={messagesRef}>
        {turns.length === 0 && !running && <WelcomeCard />}
        {turns.map((t, i) => (
          <TurnView key={i} turn={t} />
        ))}
        {progress && !paused && <ProgressBanner progress={progress} isApi={isApiMode} />}
        {paused && <PausedBanner paused={paused} onResume={onResume} onDiscard={onDiscard} />}
        {pendingConfirms.length > 0 && (
          <WriteConfirmCard
            req={pendingConfirms[0]}
            queueLen={pendingConfirms.length}
            onDecide={onDecideWrite}
          />
        )}
      </div>

      <footer>
        <div class="input-row">
          <textarea
            placeholder={
              paused
                ? '会话已暂停，先点上方"恢复"或"丢弃"…'
                : isApiMode
                  ? apiReady
                    ? '问我点什么，比如：帮我看看小红书首页最近有什么内容'
                    : '先在右上角设置里填入 API Key…'
                  : statusKind === 'err'
                    ? '先点击右上角连接 DeepSeek…'
                    : '问我点什么，比如：帮我看看小红书首页最近有什么内容'
            }
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            disabled={inputBlocked}
            rows={2}
          />
          {running ? (
            <button class="primary abort" onClick={onAbort}>
              停止
            </button>
          ) : (
            <button
              class="primary"
              onClick={onSend}
              disabled={!input.trim() || inputBlocked}
            >
              发送
            </button>
          )}
        </div>
        <div class="hint">
          Enter 发送 · Shift+Enter 换行 ·{' '}
          {isApiMode ? `由 ${apiLabel || 'API'} 提供推理` : '由 chat.deepseek.com 提供推理算力'}
        </div>
      </footer>

      {showDrawer && (
        <SettingsDrawer
          llmConfig={llmConfig}
          onSaveLlmConfig={(c) => setLlmConfig(c)}
          logs={logs}
          logCfg={logCfg}
          onChangeLogCfg={async (next) => {
            setLogCfgState((prev) => ({ ...prev, ...next }));
            await setLogConfig(next);
          }}
          onClearLogs={() => setLogs([])}
          tabStatus={tabStatus}
          onOpenDeepseek={onOpenDeepseek}
          currentSessionId={sessionId}
          onResumeFromHistory={(id) => {
            // Adopt the historical session as our active session, then ask
            // SW to resume it.
            setSessionId(id);
            setShowDrawer(false);
            const req: ResumeSessionReq = { type: 'RESUME_SESSION', sessionId: id };
            chrome.runtime.sendMessage(req).catch(() => {});
          }}
          onOpenSession={async (id) => {
            // Load the saved session into the main chat pane so the user
            // can read past turns + send follow-ups in the same DeepSeek
            // conversation. SW's tryReuseSessionTab / reattach logic will
            // pick the right tab when the next USER_MESSAGE fires.
            try {
              const r = (await chrome.runtime.sendMessage({
                type: 'GET_SESSION',
                sessionId: id,
              } satisfies GetSessionReq)) as GetSessionResp | undefined;
              const s = (r?.session as SessionState | null) ?? null;
              if (!s) return;
              setSessionId(s.id);
              setTurns(historyToUiTurns(s.history));
              setProgress(null);
              setRunning(false);
              setPaused(
                s.status === 'paused' && s.pauseReason
                  ? {
                      reason: s.pauseReason,
                      conversationUrl: s.conversationUrl,
                      pendingPromptPreview: s.pendingPrompt?.slice(0, 120),
                    }
                  : null,
              );
              setShowDrawer(false);
            } catch {}
          }}
          onDeleteHistoricalSession={(id) => {
            const req: DeleteSessionReq = { type: 'DELETE_SESSION', sessionId: id };
            chrome.runtime.sendMessage(req).catch(() => {});
            // If we just deleted the current session, clear local refs.
            if (id === sessionId) {
              setSessionId(null);
              setTurns([]);
              setProgress(null);
              setPaused(null);
            }
          }}
        />
      )}
    </>
  );
}

function ProgressBanner({ progress, isApi }: { progress: ProgressState; isApi?: boolean }) {
  const label =
    progress.phase === 'injecting'
      ? isApi
        ? `正在请求模型…`
        : `正在把消息注入到 DeepSeek tab…`
      : progress.phase === 'streaming'
        ? `${isApi ? '模型' : 'DeepSeek'} 正在生成 (~${progress.textLen ?? 0} 字)…`
        : `${isApi ? '模型' : 'DeepSeek'} 思考中… (iter ${progress.iteration})`;
  return (
    <div class="progress-banner">
      <span class="dots">
        <span class="d1" />
        <span class="d2" />
        <span class="d3" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function PausedBanner({
  paused,
  onResume,
  onDiscard,
}: {
  paused: PausedState;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const reasonText =
    paused.reason === 'tab_closed'
      ? 'DeepSeek 标签页已关闭'
      : paused.reason === 'tab_navigated_away'
        ? 'DeepSeek 标签页跳到了其他网站'
        : paused.reason === 'conv_mismatch'
          ? '该标签页切换到了另一个 DeepSeek 会话'
          : 'DeepSeek 标签页未就绪';
  return (
    <div class="paused-banner">
      <div class="title">⏸ 会话已暂停 · {reasonText}</div>
      {paused.conversationUrl && (
        <div class="hint">
          恢复将打开原会话:{' '}
          <a href={paused.conversationUrl} target="_blank" rel="noopener noreferrer">
            {paused.conversationUrl.replace('https://chat.deepseek.com', '')}
          </a>
        </div>
      )}
      {paused.pendingPromptPreview && (
        <div class="hint preview">未送达的消息预览: {paused.pendingPromptPreview}…</div>
      )}
      <div class="actions">
        {paused.conversationUrl && (
          <button class="primary" onClick={onResume}>
            恢复
          </button>
        )}
        <button class="secondary" onClick={onDiscard}>
          丢弃
        </button>
      </div>
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

function TurnView({ turn }: { turn: UiTurn }) {
  if (turn.role === 'user') {
    return <div class="msg user">{turn.text}</div>;
  }
  if (turn.role === 'system') {
    return <div class={`msg system ${turn.level === 'error' ? 'err' : ''}`}>{turn.text}</div>;
  }
  if (turn.role === 'tool') {
    return <ToolTraceCard trace={turn.trace} />;
  }
  const looksLikeParseFailure =
    turn.commands.length === 0 &&
    !!turn.rawText &&
    /```[^\n`]*\r?\n[\s\S]*?\r?\n```/.test(turn.rawText);
  return (
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
  );
}

function commandLabel(c: import('../connectors/messages').ParsedCommand): string {
  if (c.action === 'execute_tool') return c.tool ?? 'execute_tool';
  return c.action;
}

function ToolTraceCard({ trace }: { trace: ToolTrace }) {
  const badge =
    trace.status === 'started' ? 'pending' : trace.status === 'completed' ? 'ok' : 'err';
  const title =
    trace.action === 'execute_tool'
      ? `调用 ${trace.tool ?? '(?)'}`
      : trace.action === 'list_tools'
        ? `列出工具${trace.args?.category ? ` (${String(trace.args.category)})` : ''}`
        : trace.action === 'describe_tool'
          ? `查询 ${String(trace.args?.name ?? '?')}`
          : trace.action === 'done'
            ? `Agent 结束`
            : trace.action;
  return (
    <details class="trace" open={trace.status !== 'started'}>
      <summary>
        <span class={`badge ${badge}`}>
          {badge === 'pending' ? '执行中' : badge === 'ok' ? '完成' : '失败'}
        </span>
        <span>{title}</span>
        {trace.durationMs !== undefined && (
          <span style="color:var(--muted);margin-left:auto;font-size:10px">
            {trace.durationMs}ms
          </span>
        )}
      </summary>
      <div class="body">
        {trace.args && (
          <>
            <strong>参数：</strong>
            <pre>{JSON.stringify(trace.args, null, 2)}</pre>
          </>
        )}
        {trace.error && (
          <>
            <strong>错误：</strong>
            <pre>{trace.error}</pre>
          </>
        )}
        {trace.result !== undefined && (
          <>
            <strong>结果：</strong>
            <pre>{previewResult(trace.result)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function previewResult(r: unknown): string {
  try {
    const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    return s.length > 4000 ? s.slice(0, 4000) + `\n…[truncated ${s.length - 4000}]` : s;
  } catch {
    return String(r);
  }
}

function LlmBackendSection({
  config,
  onSave,
}: {
  config: LlmConfig;
  onSave: (c: LlmConfig) => void;
}) {
  const [mode, setMode] = useState<'connector' | 'api'>(config.mode);
  const [chatbot, setChatbot] = useState<ChatbotId>(
    config.mode === 'connector' ? config.chatbot : 'deepseek',
  );
  const [provider, setProvider] = useState(config.mode === 'api' ? config.provider : 'deepseek');
  const [baseUrl, setBaseUrl] = useState(
    config.mode === 'api' ? config.baseUrl : (providerById('deepseek')?.baseUrl ?? ''),
  );
  const [apiKey, setApiKey] = useState(config.mode === 'api' ? config.apiKey : '');
  const [model, setModel] = useState(
    config.mode === 'api' ? config.model : (providerById('deepseek')?.defaultModel ?? ''),
  );
  const [saved, setSaved] = useState(false);

  // Re-sync local state when the saved config arrives (or changes externally).
  // useState initializers fire ONCE at mount; the parent's loadLlmConfig() is
  // async, so on first mount `config` is still DEFAULT_CONFIG and the api-key
  // / model / baseUrl fields end up empty. Without this effect, the saved key
  // never makes it back into the form — looked like persistence was broken.
  // Safe against clobbering user edits: the parent only updates `config` after
  // save (when local state already matches the new config → effect is a no-op),
  // or on the initial load.
  useEffect(() => {
    setMode(config.mode);
    if (config.mode === 'connector') {
      setChatbot(config.chatbot);
    } else {
      setProvider(config.provider);
      setBaseUrl(config.baseUrl);
      setApiKey(config.apiKey);
      setModel(config.model);
    }
  }, [config]);

  function pickProvider(id: string): void {
    setProvider(id);
    const p = providerById(id);
    if (p && id !== 'custom') {
      setBaseUrl(p.baseUrl);
      setModel(p.defaultModel);
    }
  }

  function buildNext(): LlmConfig {
    return mode === 'connector'
      ? { mode: 'connector', chatbot }
      : {
          mode: 'api',
          provider,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
        };
  }

  function save(): void {
    const next = buildNext();
    void saveLlmConfig(next);
    onSave(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const canSave =
    mode === 'connector'
      ? CHATBOTS.find((c) => c.id === chatbot)?.implemented !== false
      : !!apiKey.trim() && !!baseUrl.trim() && !!model.trim();

  // What's CURRENTLY in effect (from the saved config, not the draft being
  // edited) — shown up top so the active backend is never ambiguous.
  const activeLabel =
    config.mode === 'api'
      ? `API · ${config.model || config.provider}`
      : `聊天网页 · ${CHATBOTS.find((c) => c.id === config.chatbot)?.label ?? config.chatbot}`;
  // Does the draft differ from what's saved? If so the user must hit Save for
  // it to take effect — surfaced as an explicit warning so it can't be missed.
  const dirty = JSON.stringify(buildNext()) !== JSON.stringify(config);

  const segStyle = (active: boolean): string =>
    `flex:1;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid ${active ? 'var(--accent,#4f7cff)' : 'var(--border,#ddd)'};background:${active ? 'var(--accent,#4f7cff)' : 'transparent'};color:${active ? '#fff' : 'inherit'}`;
  const chipStyle = (active: boolean): string =>
    `padding:2px 8px;border-radius:4px;font-size:11px;cursor:pointer;border:1px solid ${active ? 'var(--accent,#4f7cff)' : 'var(--border,#ddd)'};background:${active ? 'var(--accent,#4f7cff)' : 'transparent'};color:${active ? '#fff' : 'inherit'}`;
  const fieldStyle = 'display:flex;flex-direction:column;gap:2px;font-size:12px';

  return (
    <div class="section">
      <h4>LLM 后端</h4>
      <div style="font-size:11px;color:var(--muted);margin:-2px 0 6px">
        当前生效：<strong style="color:var(--fg)">{activeLabel}</strong>
      </div>

      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">
        选择推理来源（二选一，改完点最下方保存才生效）：
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button style={segStyle(mode === 'connector')} onClick={() => setMode('connector')}>
          {mode === 'connector' ? '● ' : '○ '}聊天网页（零 Key）
        </button>
        <button style={segStyle(mode === 'api')} onClick={() => setMode('api')}>
          {mode === 'api' ? '● ' : '○ '}自带 API Key
        </button>
      </div>

      {mode === 'connector' ? (
        <label style={fieldStyle}>
          <span>聊天网页</span>
          <select
            value={chatbot}
            onChange={(e) => setChatbot((e.target as HTMLSelectElement).value as ChatbotId)}
          >
            {CHATBOTS.map((c) => (
              <option value={c.id} disabled={!c.implemented}>
                {c.label}
              </option>
            ))}
          </select>
          <span style="font-size:11px;color:var(--muted)">
            用你已登录的聊天网页推理，零 API Key。目前仅 DeepSeek 可用。
          </span>
        </label>
      ) : (
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            {PROVIDERS.map((p) => (
              <button style={chipStyle(provider === p.id)} onClick={() => pickProvider(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <label style={fieldStyle}>
            <span>Base URL</span>
            <input
              value={baseUrl}
              placeholder="https://api.deepseek.com"
              onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
            />
          </label>
          <label style={fieldStyle}>
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              placeholder="sk-…"
              onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </label>
          <label style={fieldStyle}>
            <span>Model</span>
            <input
              value={model}
              placeholder="deepseek-chat"
              onInput={(e) => setModel((e.target as HTMLInputElement).value)}
            />
          </label>
          <span style="font-size:11px;color:var(--muted)">
            任何兼容 OpenAI /chat/completions 的服务都可用。Key 仅存于本机 chrome.storage。
          </span>
        </div>
      )}

      {dirty && !saved && (
        <div style="font-size:11px;color:var(--error);margin-top:8px">
          ⚠ 有未保存的改动 —— 点下方按钮后才会切换 / 生效
        </div>
      )}
      <button
        class="icon-btn"
        style={`margin-top:8px${dirty && !saved ? ';border-color:var(--accent);color:var(--accent);font-weight:600' : ''}`}
        disabled={!canSave}
        onClick={save}
      >
        {saved ? '已保存 ✓' : dirty ? '保存并启用' : '保存后端设置'}
      </button>
    </div>
  );
}

function SettingsDrawer(props: {
  logs: LogEntry[];
  logCfg: LogConfig;
  onChangeLogCfg: (next: Partial<LogConfig>) => Promise<void>;
  onClearLogs: () => void;
  tabStatus: ChatbotTabStatusEvt | null;
  onOpenDeepseek: () => void;
  currentSessionId: string | null;
  onResumeFromHistory: (sessionId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onDeleteHistoricalSession: (sessionId: string) => void;
  llmConfig: LlmConfig;
  onSaveLlmConfig: (c: LlmConfig) => void;
}) {
  return (
    <div class="drawer">
      <LlmBackendSection config={props.llmConfig} onSave={props.onSaveLlmConfig} />
      {props.llmConfig.mode === 'connector' && (
        <div class="section">
          <h4>DeepSeek 标签页</h4>
        <div style="font-size:11px;color:var(--muted)">
          {props.tabStatus?.tabId === null || !props.tabStatus
            ? '未打开'
            : `tab=${props.tabStatus.tabId} · ${props.tabStatus.ready ? '已登录' : '未登录'}`}
        </div>
        <button class="icon-btn" style="margin-top:4px" onClick={props.onOpenDeepseek}>
          打开 / 切换至 chat.deepseek.com
        </button>
        </div>
      )}
      <AdaptersSection />
      <HistorySection
        currentSessionId={props.currentSessionId}
        onResume={props.onResumeFromHistory}
        onOpen={props.onOpenSession}
        onDelete={props.onDeleteHistoricalSession}
      />
      <div class="section">
        <h4>日志</h4>
        <label class="row">
          <span>详细日志</span>
          <input
            type="checkbox"
            checked={props.logCfg.enabled}
            onChange={(e) =>
              void props.onChangeLogCfg({ enabled: (e.target as HTMLInputElement).checked })
            }
          />
        </label>
        <button class="icon-btn" onClick={props.onClearLogs}>
          清空缓冲区
        </button>
        <div class="log">
          {props.logs.length === 0 ? (
            <div class="entry">（暂无日志）</div>
          ) : (
            props.logs.slice(-200).map((e, i) => (
              <div key={i} class={`entry ${e.level}`}>
                <span class="ts">{new Date(e.ts).toLocaleTimeString()} </span>
                <span class="scope">[{e.scope}]</span> <span>{e.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function HistorySection({
  currentSessionId,
  onResume,
  onOpen,
  onDelete,
}: {
  currentSessionId: string | null;
  onResume: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}) {
  const [list, setList] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    // Auto-refresh when SESSION_DONE / SESSION_PAUSED happens — those are
    // exactly the moments the list contents change.
    const handler = (m: unknown) => {
      const t = (m as { type?: string })?.type;
      if (t === 'SESSION_DONE' || t === 'SESSION_PAUSED' || t === 'ASSISTANT_TURN') {
        void refresh();
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  async function loadDetail(id: string): Promise<void> {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    try {
      const req: GetSessionReq = { type: 'GET_SESSION', sessionId: id };
      const r = (await chrome.runtime.sendMessage(req)) as GetSessionResp | undefined;
      setDetail((r?.session as SessionState | null) ?? null);
    } catch {
      setDetail(null);
    }
  }

  return (
    <div class="section">
      <h4>
        历史会话 <span class="muted">({list.length})</span>
        <button
          class="icon-btn refresh-btn"
          title="刷新"
          onClick={(e) => {
            e.stopPropagation();
            void refresh();
          }}
        >
          ⟳
        </button>
      </h4>
      {loading ? (
        <div class="hist-empty">加载中…</div>
      ) : list.length === 0 ? (
        <div class="hist-empty">（还没有历史会话）</div>
      ) : (
        <ul class="hist-list">
          {list.map((s) => {
            const isCurrent = s.id === currentSessionId;
            const isExpanded = expanded === s.id;
            return (
              <li key={s.id} class={`hist-item ${isCurrent ? 'current' : ''}`}>
                <div class="hist-head" onClick={() => void loadDetail(s.id)}>
                  <span class={`hist-badge ${badgeClass(s.status)}`}>{badgeText(s.status)}</span>
                  <span class="hist-preview">
                    {s.preview || <span class="muted">（无内容）</span>}
                  </span>
                  <span class="hist-ts">{relativeTime(s.updatedAt)}</span>
                </div>
                <div class="hist-meta">
                  iter {s.iterations} · {s.turnCount} 轮消息 · {s.toolCallCount} 次工具调用
                  {isCurrent && <span class="hist-current-tag"> · 当前会话</span>}
                </div>
                {isExpanded && (
                  <div class="hist-detail">
                    {detail === null ? (
                      <div class="muted">加载详情中…</div>
                    ) : (
                      <SessionDetailView session={detail} />
                    )}
                    <div class="hist-actions">
                      {!isCurrent && (
                        <button
                          class="primary"
                          title="把这条会话加载到主聊天面板，可以继续追问（保留 DeepSeek conversation 上下文）"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(s.id);
                          }}
                        >
                          打开
                        </button>
                      )}
                      {s.status === 'paused' && s.conversationUrl && (
                        <button
                          class="primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            onResume(s.id);
                          }}
                        >
                          恢复会话
                        </button>
                      )}
                      <button
                        class="danger"
                        disabled={isCurrent}
                        title={
                          isCurrent
                            ? '不能删除正在进行的会话，先点 "+ 新对话"'
                            : '从存储中永久删除这个会话'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm('确认删除这条历史会话？')) onDelete(s.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SessionDetailView({ session }: { session: SessionState }) {
  return (
    <div class="hist-turns">
      {session.history.length === 0 ? (
        <div class="muted">（没有消息）</div>
      ) : (
        session.history.map((t, i) => <DetailTurn key={i} turn={t} />)
      )}
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
    case 'paused':
      return 'warn';
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
    case 'paused':
      return '已暂停';
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
