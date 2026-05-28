/**
 * DeepSeek chatbot connector — isolated-world content script.
 *
 * Responsibilities:
 *   1. Announce readiness when chat.deepseek.com is loaded + user is signed in.
 *   2. On INJECT_PROMPT: type the text into the textarea (via the native input
 *      setter so React's onChange sees it), then click the send button.
 *   3. After sending, observe the message list for the next assistant turn,
 *      wait for it to stabilise, then send CHATBOT_RESPONSE back with the
 *      extracted markdown + parsed agent-commands.
 *   4. On NEW_CHAT request (carried by INJECT_PROMPT with `freshChat: true` —
 *      not used by SW yet; orchestrator just calls inject after navigation): click "New chat".
 *
 * The connector keeps no long-term state; everything is keyed off the
 * `iterationId` issued by the service worker. SW handles sessionId mapping.
 */

import { log, warn, error as logError } from '../../runtime/log';
import { parseAgentCommands } from '../../agent/command-parser';
import {
  TEXTAREA,
  TEXTAREA_FALLBACK,
  MESSAGE_LIST,
  MESSAGE_ITEM,
  ASSISTANT_BODY,
  THINK_CONTENT,
  findSendButton,
  findNewChatButton,
  findBusyIndicator,
  findRetryButtonNear,
  isSendEnabled,
  probeDomReady,
  extractMarkdownFromDom,
} from './selectors';
import type {
  ChatbotBusyEvt,
  ChatbotErrorEvt,
  ChatbotResponseEvt,
  ChatbotStreamingEvt,
  ConnectorReadyEvt,
  InjectAckEvt,
  InjectPromptReq,
  Message,
} from '../messages';

const SCOPE = 'connector:deepseek';

const RESPONSE_QUIET_MS = 1500; // text must be unchanged this long → done
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const SEND_BUTTON_WAIT_MS = 8000;
const TEXTAREA_WAIT_MS = 60_000; // waits for login flow
const STREAMING_NOTIFY_MS = 1000; // send CHATBOT_STREAMING at most once per second

/** Backoff schedule for clicking DeepSeek's own retry button when its server
 * reports "busy". On the Nth busy detection we wait BUSY_RETRY_BACKOFFS[N]
 * milliseconds, then click retry. After exhausting the array we report
 * CHATBOT_ERROR so the orchestrator surfaces the failure to the user. */
const BUSY_RETRY_BACKOFFS_MS = [5_000, 15_000, 30_000];

type WatchPhase = 'observing' | 'busy_waiting' | 'finished';

interface ActiveWatch {
  iterationId: string;
  sessionId: string;
  baselineKey: number;
  observer: MutationObserver;
  pollHandle: ReturnType<typeof setInterval>;
  timeoutHandle: ReturnType<typeof setTimeout>;
  stabilityHandle: ReturnType<typeof setTimeout> | null;
  busyRetryHandle: ReturnType<typeof setTimeout> | null;
  busyRetryCount: number;
  phase: WatchPhase;
  lastSnapshot: string;
  lastStreamingNotifyTs: number;
}

let activeWatch: ActiveWatch | null = null;

bootstrap();

async function bootstrap(): Promise<void> {
  log(SCOPE, 'content script loaded', { url: location.href });
  chrome.runtime.onMessage.addListener(handleMessage);
  await sleep(200); // let the page settle a beat
  void announceReady();
}

async function announceReady(): Promise<void> {
  // Fire an immediate announcement with whatever the DOM currently looks like
  // so the SidePanel can stop showing "not connected" while we wait for the
  // SPA to settle. A second announcement goes out once the textarea appears
  // (or 30s elapse), at which point loggedIn reflects the real state.
  const immediate = probeDomReady();
  void sendToSW({
    type: 'CONNECTOR_READY',
    chatbot: 'deepseek',
    loggedIn: immediate.loggedIn,
    url: location.href,
  } satisfies ConnectorReadyEvt);
  log(SCOPE, 'announceReady (immediate)', { loggedIn: immediate.loggedIn });

  if (immediate.loggedIn) return;

  const found = await waitForSelector<HTMLTextAreaElement>(
    TEXTAREA,
    TEXTAREA_WAIT_MS,
    TEXTAREA_FALLBACK,
  );
  const probe = probeDomReady();
  const evt: ConnectorReadyEvt = {
    type: 'CONNECTOR_READY',
    chatbot: 'deepseek',
    loggedIn: !!found && probe.loggedIn,
    url: location.href,
  };
  log(SCOPE, 'announceReady (delayed)', evt);
  void sendToSW(evt);
}

function handleMessage(
  msg: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean | undefined {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Message;
  switch (m.type) {
    case 'INJECT_PROMPT': {
      void handleInject(m).then(
        (ok) => sendResponse({ ok }),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
      return true; // async sendResponse
    }
    case 'PING_CONNECTOR': {
      sendResponse({ type: 'PONG_CONNECTOR' });
      return false;
    }
    default:
      return;
  }
}

async function handleInject(req: InjectPromptReq): Promise<boolean> {
  log(SCOPE, `inject begin iteration=${req.iterationId}`, { textLen: req.text.length });
  cancelActiveWatch('superseded by new inject');

  const baselineKey = lastVirtualKey();

  const textarea = await waitForSelector<HTMLTextAreaElement>(TEXTAREA, 10_000, TEXTAREA_FALLBACK);
  if (!textarea) {
    const err = 'textarea not found';
    logError(SCOPE, err);
    void sendInjectAck(req.iterationId, false, err);
    throw new Error(err);
  }
  textarea.focus();
  setReactInputValue(textarea, req.text);
  log(SCOPE, 'textarea value set, focusing + waiting for send button');

  // After dispatching `input`, React updates state, the button becomes
  // enabled on the next render. Poll briefly.
  const sendBtn = await waitForCondition(() => {
    const b = findSendButton();
    return b && isSendEnabled(b) ? b : null;
  }, SEND_BUTTON_WAIT_MS);
  if (!sendBtn) {
    const err = 'send button never became enabled';
    logError(SCOPE, err);
    void sendInjectAck(req.iterationId, false, err);
    throw new Error(err);
  }
  sendBtn.click();
  log(SCOPE, 'send clicked');

  void sendInjectAck(req.iterationId, true);
  startWatch(req.sessionId, req.iterationId, baselineKey);
  return true;
}

function startWatch(sessionId: string, iterationId: string, baselineKey: number): void {
  log(SCOPE, `startWatch iteration=${iterationId} baseline=${baselineKey}`);
  const target = document.querySelector(MESSAGE_LIST) ?? document.body;
  const obs = new MutationObserver(() => maybeCheck());
  obs.observe(target, { childList: true, subtree: true, characterData: true });
  const watch: ActiveWatch = {
    iterationId,
    sessionId,
    baselineKey,
    observer: obs,
    pollHandle: setInterval(maybeCheck, 600),
    timeoutHandle: setTimeout(() => finish('timeout'), RESPONSE_TIMEOUT_MS),
    stabilityHandle: null,
    busyRetryHandle: null,
    busyRetryCount: 0,
    phase: 'observing',
    lastSnapshot: '',
    lastStreamingNotifyTs: 0,
  };
  activeWatch = watch;

  function maybeCheck() {
    if (watch.phase !== 'observing') return;
    // Check for "server busy" first — if DeepSeek failed our request it will
    // never grow a new assistant-message element and our stability watcher
    // would just time out.
    const busy = findBusyIndicator();
    if (busy) {
      onBusy(busy);
      return;
    }
    const el = findLatestAssistantMessage(watch.baselineKey);
    if (!el) return;
    const snapshot = (el.querySelector(ASSISTANT_BODY)?.textContent ?? '').trim();
    if (snapshot.length === 0) return;
    if (snapshot === watch.lastSnapshot) {
      if (!watch.stabilityHandle) {
        watch.stabilityHandle = setTimeout(() => finish('stable'), RESPONSE_QUIET_MS);
      }
      return;
    }
    watch.lastSnapshot = snapshot;
    if (watch.stabilityHandle) {
      clearTimeout(watch.stabilityHandle);
      watch.stabilityHandle = null;
    }
    // Throttled streaming notification so SidePanel can show "正在生成 (~N 字)…".
    const now = Date.now();
    if (now - watch.lastStreamingNotifyTs > STREAMING_NOTIFY_MS) {
      watch.lastStreamingNotifyTs = now;
      void sendStreaming(watch.sessionId, watch.iterationId, snapshot.length);
    }
  }

  function onBusy(busyEl: HTMLElement): void {
    if (watch.busyRetryCount >= BUSY_RETRY_BACKOFFS_MS.length) {
      finishWithError(
        'busy_exhausted',
        `DeepSeek reported "server busy" ${watch.busyRetryCount} times.`,
      );
      return;
    }
    const wait = BUSY_RETRY_BACKOFFS_MS[watch.busyRetryCount];
    watch.busyRetryCount += 1;
    watch.phase = 'busy_waiting';
    if (watch.stabilityHandle) {
      clearTimeout(watch.stabilityHandle);
      watch.stabilityHandle = null;
    }
    log(
      SCOPE,
      `chatbot busy detected (retry ${watch.busyRetryCount}/${BUSY_RETRY_BACKOFFS_MS.length} in ${wait}ms)`,
    );
    void sendBusy(watch.sessionId, watch.iterationId, watch.busyRetryCount, wait);
    watch.busyRetryHandle = setTimeout(() => {
      if (watch.phase !== 'busy_waiting') return;
      const retry = findRetryButtonNear(busyEl) ?? findFreshRetry();
      if (!retry) {
        finishWithError('busy_exhausted', 'Retry button vanished before backoff elapsed');
        return;
      }
      log(SCOPE, 'clicking DeepSeek retry button');
      retry.click();
      // Reset observer state: the failed message item may be removed / replaced.
      watch.lastSnapshot = '';
      watch.phase = 'observing';
    }, wait);
  }

  /** Fallback when the captured busyEl was detached from the DOM during
   * backoff — look for any current busy indicator and resolve its retry. */
  function findFreshRetry(): HTMLElement | null {
    const fresh = findBusyIndicator();
    return fresh ? findRetryButtonNear(fresh) : null;
  }

  function finishWithError(
    reason: 'busy_exhausted' | 'timeout' | 'unknown',
    message?: string,
  ): void {
    if (watch.phase === 'finished') return;
    watch.phase = 'finished';
    cleanup();
    const evt: ChatbotErrorEvt = {
      type: 'CHATBOT_ERROR',
      sessionId: watch.sessionId,
      iterationId: watch.iterationId,
      reason,
      message,
    };
    log(SCOPE, `finish with error reason=${reason}`, { message });
    void sendToSW(evt);
  }

  function finish(reason: 'stable' | 'timeout'): void {
    if (watch.phase === 'finished') return;
    if (reason === 'timeout') {
      finishWithError('timeout', `No response within ${RESPONSE_TIMEOUT_MS}ms`);
      return;
    }
    watch.phase = 'finished';
    cleanup();
    const el = findLatestAssistantMessage(watch.baselineKey);
    if (!el) {
      logError(SCOPE, 'finish: no assistant element', { reason });
      void sendChatbotResponse({
        sessionId: watch.sessionId,
        iterationId: watch.iterationId,
        rawText: '',
        cleanedText: '',
        commands: [],
      });
      return;
    }
    const assistantBody = el.querySelector(ASSISTANT_BODY) as HTMLElement | null;
    const thinkBody = el.querySelector(THINK_CONTENT) as HTMLElement | null;
    const rawMd = assistantBody ? extractMarkdownFromDom(assistantBody) : '';
    const reasoning = thinkBody ? extractMarkdownFromDom(thinkBody) : '';
    const parsed = parseAgentCommands(rawMd);
    log(SCOPE, `finish reason=${reason}`, {
      rawLen: rawMd.length,
      cleanedLen: parsed.cleanedText.length,
      reasoningLen: reasoning.length,
      commandCount: parsed.commands.length,
    });
    void sendChatbotResponse({
      sessionId: watch.sessionId,
      iterationId: watch.iterationId,
      rawText: rawMd,
      cleanedText: parsed.cleanedText,
      reasoningText: reasoning || undefined,
      commands: parsed.commands,
      currentUrl: location.href,
    });
  }

  function cleanup() {
    if (activeWatch === watch) activeWatch = null;
    watch.observer.disconnect();
    clearInterval(watch.pollHandle);
    clearTimeout(watch.timeoutHandle);
    if (watch.stabilityHandle) clearTimeout(watch.stabilityHandle);
    if (watch.busyRetryHandle) clearTimeout(watch.busyRetryHandle);
  }
}

function cancelActiveWatch(reason: string): void {
  if (!activeWatch) return;
  log(SCOPE, `cancelActiveWatch: ${reason}`);
  activeWatch.phase = 'finished';
  activeWatch.observer.disconnect();
  clearInterval(activeWatch.pollHandle);
  clearTimeout(activeWatch.timeoutHandle);
  if (activeWatch.stabilityHandle) clearTimeout(activeWatch.stabilityHandle);
  if (activeWatch.busyRetryHandle) clearTimeout(activeWatch.busyRetryHandle);
  activeWatch = null;
}

function lastVirtualKey(): number {
  let max = 0;
  document.querySelectorAll(MESSAGE_ITEM).forEach((i) => {
    const k = Number(i.getAttribute('data-virtual-list-item-key') ?? 0);
    if (k > max) max = k;
  });
  return max;
}

function findLatestAssistantMessage(baselineKey: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestKey = baselineKey;
  document.querySelectorAll(MESSAGE_ITEM).forEach((i) => {
    const k = Number(i.getAttribute('data-virtual-list-item-key') ?? 0);
    if (k > bestKey && i.querySelector(ASSISTANT_BODY)) {
      best = i as HTMLElement;
      bestKey = k;
    }
  });
  return best;
}

/* ───────── messaging helpers ───────── */

async function sendToSW(msg: Message): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (e) {
    warn(SCOPE, 'sendToSW failed', e);
  }
}

async function sendInjectAck(iterationId: string, ok: boolean, error?: string): Promise<void> {
  const evt: InjectAckEvt = { type: 'INJECT_ACK', iterationId, ok, error };
  await sendToSW(evt);
}

async function sendBusy(
  sessionId: string,
  iterationId: string,
  retryCount: number,
  nextRetryInMs: number,
): Promise<void> {
  const evt: ChatbotBusyEvt = {
    type: 'CHATBOT_BUSY',
    sessionId,
    iterationId,
    retryCount,
    maxRetries: BUSY_RETRY_BACKOFFS_MS.length,
    nextRetryInMs,
  };
  await sendToSW(evt);
}

async function sendChatbotResponse(p: {
  sessionId: string;
  iterationId: string;
  rawText: string;
  cleanedText: string;
  reasoningText?: string;
  commands: import('../messages').ParsedCommand[];
  currentUrl?: string;
}): Promise<void> {
  const evt: ChatbotResponseEvt = {
    type: 'CHATBOT_RESPONSE',
    sessionId: p.sessionId,
    iterationId: p.iterationId,
    rawText: p.rawText,
    cleanedText: p.cleanedText,
    reasoningText: p.reasoningText,
    commands: p.commands,
    currentUrl: p.currentUrl,
  };
  await sendToSW(evt);
}

async function sendStreaming(
  sessionId: string,
  iterationId: string,
  textLen: number,
): Promise<void> {
  const evt: ChatbotStreamingEvt = {
    type: 'CHATBOT_STREAMING',
    sessionId,
    iterationId,
    textLen,
  };
  await sendToSW(evt);
}

/* ───────── DOM helpers ───────── */

function setReactInputValue(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitForSelector<T extends HTMLElement = HTMLElement>(
  sel: string,
  timeoutMs: number,
  fallback?: string,
): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el =
      (document.querySelector(sel) as T | null) ??
      (fallback ? (document.querySelector(fallback) as T | null) : null);
    if (el) return el;
    await sleep(80);
  }
  return null;
}

async function waitForCondition<T>(
  test: () => T | null | false | undefined,
  timeoutMs: number,
): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = test();
    if (v) return v as T;
    await sleep(80);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ───────── exposed for completeness (not used internally) ───────── */

export async function clickNewChat(): Promise<boolean> {
  const btn = findNewChatButton();
  if (!btn) {
    warn(SCOPE, 'clickNewChat: button not found');
    return false;
  }
  btn.click();
  log(SCOPE, 'new chat clicked');
  // Wait until the textarea reappears in a clean state.
  await waitForSelector(TEXTAREA, 10_000, TEXTAREA_FALLBACK);
  return true;
}
