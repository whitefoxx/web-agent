import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Markdown } from './Markdown';
import type { UiTurn } from './types';
import {
  type AbortSessionReq,
  type AssistantTurnEvt,
  type ChatbotBusyEvt,
  type ChatbotStreamingEvt,
  type ChatbotTabStatusEvt,
  type DiscardSessionReq,
  type EnsureChatbotTabReq,
  type IterationProgressEvt,
  type LogEntryEvt,
  type LogsResponse,
  type Message,
  type RequestLogsReq,
  type ResumeSessionReq,
  type SessionDoneEvt,
  type SessionPausedEvt,
  type ToolTrace,
  type ToolTraceEvt,
  type UserMessageReq,
} from '../connectors/messages';
import type { LogEntry, LogConfig } from '../runtime/log';
import { getLogConfig, setLogConfig, subscribeLog } from '../runtime/log';
import { makeSessionId } from '../agent/session';

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
  const [tabStatus, setTabStatus] = useState<ChatbotTabStatusEvt | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logCfg, setLogCfgState] = useState<LogConfig>(() => getLogConfig());

  const messagesRef = useRef<HTMLDivElement>(null);

  /* mount: ensure tab status, attach listeners */
  useEffect(() => {
    void requestEnsureTab();
    void requestLogs();
    const handler = (m: unknown) => onIncomingMessage(m as Message);
    chrome.runtime.onMessage.addListener(handler);
    const unsubLog = subscribeLog((e) => setLogs((cur) => append(cur, e, 500)));
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      unsubLog();
    };
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
      case 'LOG_ENTRY':
        setLogs((cur) => append(cur, (m as LogEntryEvt).entry, 500));
        break;
      default:
        break;
    }
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
    // NOTE: deliberately NOT clearing sessionId — follow-up messages stay
    // in the same DeepSeek conversation so the chatbot keeps context. The
    // user explicitly starts a new conversation via the header "+ 新对话"
    // button (which calls onNewChat). On 'user_abort' / 'error' we also
    // drop the binding since the session ended unhealthy.
    if (m.reason === 'error' || m.reason === 'user_abort') {
      setSessionId(null);
    }
    setTurns((cur) => [
      ...cur,
      {
        role: 'system',
        text: m.error
          ? `会话结束：${m.error}`
          : m.reason === 'no_more_commands'
            ? '回答完成'
            : `会话结束（${m.reason}）`,
        level: m.error ? 'error' : 'info',
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

  return (
    <>
      <header>
        <span class="title">WebChat Agent</span>
        <span
          class={`status-pill ${statusKind}`}
          onClick={statusKind === 'err' ? onOpenDeepseek : () => void requestEnsureTab()}
          title={statusKind === 'err' ? '点击打开 chat.deepseek.com' : '点击刷新状态'}
        >
          <span class="dot" />
          {statusText}
        </span>
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
        {progress && !paused && <ProgressBanner progress={progress} />}
        {paused && <PausedBanner paused={paused} onResume={onResume} onDiscard={onDiscard} />}
      </div>

      <footer>
        <div class="input-row">
          <textarea
            placeholder={
              paused
                ? '会话已暂停，先点上方"恢复"或"丢弃"…'
                : statusKind === 'err'
                  ? '先点击右上角连接 DeepSeek…'
                  : '问我点什么，比如：帮我看看小红书首页最近有什么内容'
            }
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            disabled={statusKind === 'err' || !!paused}
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
              disabled={!input.trim() || statusKind === 'err' || !!paused}
            >
              发送
            </button>
          )}
        </div>
        <div class="hint">Enter 发送 · Shift+Enter 换行 · 由 chat.deepseek.com 提供推理算力</div>
      </footer>

      {showDrawer && (
        <SettingsDrawer
          logs={logs}
          logCfg={logCfg}
          onChangeLogCfg={async (next) => {
            setLogCfgState((prev) => ({ ...prev, ...next }));
            await setLogConfig(next);
          }}
          onClearLogs={() => setLogs([])}
          tabStatus={tabStatus}
          onOpenDeepseek={onOpenDeepseek}
        />
      )}
    </>
  );
}

function ProgressBanner({ progress }: { progress: ProgressState }) {
  const label =
    progress.phase === 'injecting'
      ? `正在把消息注入到 DeepSeek tab…`
      : progress.phase === 'streaming'
        ? `DeepSeek 正在生成 (~${progress.textLen ?? 0} 字)…`
        : `DeepSeek 思考中… (iter ${progress.iteration})`;
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

function SettingsDrawer(props: {
  logs: LogEntry[];
  logCfg: LogConfig;
  onChangeLogCfg: (next: Partial<LogConfig>) => Promise<void>;
  onClearLogs: () => void;
  tabStatus: ChatbotTabStatusEvt | null;
  onOpenDeepseek: () => void;
}) {
  return (
    <div class="drawer">
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

function append<T>(arr: T[], item: T, max: number): T[] {
  const next = [...arr, item];
  return next.length > max ? next.slice(-max) : next;
}
