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
} from './Icons';
import type { UiTurn } from './types';
import {
  type AbortSessionReq,
  type AssistantTurnEvt,
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
  type SessionSummary,
  type ToolTrace,
  type ToolTraceEvt,
  type UserMessageReq,
  type WriteConfirmReq,
  type WriteConfirmResp,
} from '../messages';
import type { SessionState, Turn } from '../agent/session';
import type { LogEntry, LogConfig } from '../runtime/log';
import { getLogConfig, setLogConfig, subscribeLog } from '../runtime/log';
import { makeSessionId } from '../agent/session';
import {
  DEFAULT_CONFIG,
  PROVIDERS,
  loadLlmConfig,
  loadProfiles,
  upsertProfile,
  deleteProfile,
  setActiveProfile,
  newProfileId,
  autoLabel,
  providerById,
  type LlmConfig,
  type LlmProfile,
  type LlmProfileStore,
} from '../config/llm-config';

interface ProgressState {
  iteration: number;
  phase: 'injecting' | 'awaiting' | 'streaming';
  textLen?: number;
}

type View = 'closed' | 'menu' | 'backend' | 'adapters' | 'history' | 'logs';

const PAGE_LABELS: Record<Exclude<View, 'closed' | 'menu'>, string> = {
  backend: 'LLM 后端',
  adapters: 'Adapters',
  history: '历史会话',
  logs: '日志',
};

export function App() {
  const [turns, setTurns] = useState<UiTurn[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [pendingConfirms, setPendingConfirms] = useState<WriteConfirmReq[]>([]);
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
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  function eventBelongsToCurrentSession(eventSessionId: string | undefined): boolean {
    if (!eventSessionId) return true; // global event (no session scope)
    return sessionIdRef.current === eventSessionId;
  }

  /* mount: attach listeners, open keep-alive port */
  useEffect(() => {
    void requestLogs();
    const handler = (m: unknown) => onIncomingMessage(m as Message);
    chrome.runtime.onMessage.addListener(handler);
    const unsubLog = subscribeLog((e) => setLogs((cur) => append(cur, e, 500)));
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
      case 'TOOL_TRACE':
      case 'SESSION_DONE':
      case 'SESSION_NOTICE':
      case 'ITERATION_PROGRESS':
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
      case 'SESSION_NOTICE':
        onSessionNotice(m as SessionNoticeEvt);
        break;
      case 'ITERATION_PROGRESS':
        onIterationProgress(m as IterationProgressEvt);
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
    // NOTE: deliberately NOT clearing sessionId on 'no_more_commands' /
    // 'user_abort' — follow-up messages stay in the same session so the LLM
    // keeps full context. On a real 'error' we drop the binding so the user
    // starts fresh. EXCEPTION: a `recoverable` error means the SW was just
    // recycled mid-turn; the history is persisted in IDB and the banner
    // promises "接着聊（基于历史上下文）", so we KEEP the binding — the next
    // message resumes the same session with full context.
    if (m.reason === 'error' && !m.recoverable) setSessionId(null);
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
    if (!text || running) return;
    // Reuse sessionId across follow-up messages so the SW can continue in
    // the same chat history. Only allocate a new one if we're starting fresh
    // (no prior session) or the previous one ended.
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

  function onNewChat(): void {
    if (running) onAbort();
    setSessionId(null);
    setTurns([]);
    setProgress(null);
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

      <div class="messages" ref={messagesRef}>
        {turns.length === 0 && !running && <WelcomeCard />}
        {turns.map((t, i) => (
          <TurnView key={i} turn={t} />
        ))}
        {progress && <ProgressBanner progress={progress} />}
        {pendingConfirms.length > 0 && (
          <WriteConfirmCard
            req={pendingConfirms[0]}
            queueLen={pendingConfirms.length}
            onDecide={onDecideWrite}
          />
        )}
      </div>

      <footer>
        <div class={`composer ${inputBlocked && !running ? 'disabled' : ''}`}>
          <textarea
            placeholder={
              apiReady
                ? '问我点什么，比如：帮我看看小红书首页最近有什么内容'
                : '先在右上角菜单 → LLM 后端 填入 API Key…'
            }
            value={input}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            disabled={inputBlocked}
            rows={1}
          />
          {running ? (
            <button class="send-btn stop" onClick={onAbort} title="停止生成" aria-label="停止">
              <IconStop size={12} />
            </button>
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
        <div class="hint">Enter 发送 · Shift+Enter 换行 · 由 {apiLabel || 'API'} 提供推理</div>
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

function ProgressBanner({ progress }: { progress: ProgressState }) {
  const label =
    progress.phase === 'injecting'
      ? '正在请求模型…'
      : progress.phase === 'streaming'
        ? `模型正在生成 (~${progress.textLen ?? 0} 字)…`
        : `模型思考中… (iter ${progress.iteration})`;
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

function commandLabel(c: import('../messages').ParsedCommand): string {
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
  const [store, setStore] = useState<LlmProfileStore>({ activeId: '', profiles: [] });
  const [loading, setLoading] = useState(true);
  /** null = list view, 'new' = create form, profile = edit form prefilled. */
  const [editing, setEditing] = useState<LlmProfile | 'new' | null>(null);

  async function refresh(): Promise<void> {
    const s = await loadProfiles();
    setStore(s);
    setLoading(false);
    const cfg = await loadLlmConfig();
    onSave(cfg);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleActivate(id: string): Promise<void> {
    await setActiveProfile(id);
    await refresh();
  }

  async function handleDelete(p: LlmProfile): Promise<void> {
    if (!confirm(`删除配置「${p.label}」?这无法撤销。`)) return;
    await deleteProfile(p.id);
    await refresh();
  }

  async function handleSave(profile: LlmProfile, activate: boolean): Promise<void> {
    await upsertProfile(profile, { activate });
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
        onSave={(p) => handleSave(p, isNew)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const active = store.profiles.find((p) => p.id === store.activeId);
  const ready = !!active?.apiKey;
  const activeLabel = active ? active.label : '未配置 API Key';
  const activeMeta = active
    ? `${providerById(active.provider)?.label ?? active.provider} · ${active.model || '(未填 model)'}`
    : '';

  return (
    <>
      <div class="status-card">
        <span class={`dot ${ready ? '' : 'warn'}`} />
        <div style="flex:1;min-width:0">
          <div class="label">当前生效</div>
          <div class="value">{activeLabel}</div>
          {activeMeta && (
            <div style="font-size:11.5px;color:var(--muted);margin-top:2px">{activeMeta}</div>
          )}
        </div>
      </div>

      <div class="section">
        <h4>
          API Keys
          {store.profiles.length > 0 && <span class="muted"> · {store.profiles.length} 个</span>}
        </h4>
        <p class="section-hint">
          可保存多套 key,点「切换」即时换用。Key 仅存于本机 chrome.storage。
        </p>
        {loading ? (
          <div style="color:var(--muted);font-size:13px">加载中…</div>
        ) : store.profiles.length === 0 ? (
          <div
            style="padding:20px;text-align:center;color:var(--muted);font-size:13px;border:1px dashed var(--border);border-radius:10px"
          >
            还没保存任何 API Key。点下方「+ 新建配置」开始。
          </div>
        ) : (
          <div class="profile-list">
            {store.profiles.map((p) => (
              <ProfileCard
                key={p.id}
                profile={p}
                active={p.id === store.activeId}
                onActivate={() => void handleActivate(p.id)}
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
  active,
  onActivate,
  onEdit,
  onDelete,
}: {
  profile: LlmProfile;
  active: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): preact.JSX.Element {
  const providerLabel = providerById(profile.provider)?.label ?? profile.provider;
  return (
    <div class={`profile-card${active ? ' active' : ''}`}>
      <div class="profile-card-main">
        <div class="profile-card-head">
          {active && <span class="active-badge">✓ 在用</span>}
          <span class="profile-card-label">{profile.label}</span>
        </div>
        <div class="profile-card-meta">
          {providerLabel} · {profile.model || '(未填 model)'}
        </div>
        <div class="profile-card-key">{maskApiKey(profile.apiKey)}</div>
      </div>
      <div class="profile-card-actions">
        {!active && (
          <button class="btn sm outline" onClick={onActivate} title="设为当前生效">
            切换
          </button>
        )}
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
            按 endpoint 实际支持的模型名填(例:deepseek-chat / gpt-4o / claude-sonnet-4-6)。
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
