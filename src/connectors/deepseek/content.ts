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
  findCopyButtonIn,
  findRegenerateButtonIn,
  findRetryButtonNear,
  findStoppedIndicatorIn,
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

/** Backoff for clicking the per-message "Regenerate" button when DeepSeek
 * stops mid-generation (the thinking header shows "Stopped"). Shorter than
 * busy backoff — this is a local hiccup, not a server-side load problem. */
const STOPPED_REGEN_BACKOFFS_MS = [2_000, 5_000];

/** After clicking Regenerate, suppress further Stopped detection for this
 * many ms — gives the previous attempt's "Stopped" span time to be torn
 * down before we re-check. */
const STOPPED_COOLDOWN_MS = 5_000;

type WatchPhase = 'observing' | 'busy_waiting' | 'stopped_waiting' | 'finished';

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
  regenerateHandle: ReturnType<typeof setTimeout> | null;
  regenerateCount: number;
  /** Earliest Date.now() at which Stopped detection is allowed to fire
   * again. Used as a cool-down after clicking Regenerate so we don't
   * re-trigger on the previous attempt's lingering "Stopped" span. */
  stoppedSuppressUntil: number;
  phase: WatchPhase;
  lastSnapshot: string;
  lastStreamingNotifyTs: number;
}

let activeWatch: ActiveWatch | null = null;

/** Captures from our MAIN-world clipboard-tap. We don't keep a long
 * history; we just need the most-recent one to correlate with the Copy
 * click we just issued. */
let lastClipboardCapture: { text: string; ts: number } | null = null;

bootstrap();

async function bootstrap(): Promise<void> {
  log(SCOPE, 'content script loaded', { url: location.href });
  chrome.runtime.onMessage.addListener(handleMessage);
  window.addEventListener('message', handleWindowMessage);
  await sleep(200); // let the page settle a beat
  void announceReady();
}

function handleWindowMessage(ev: MessageEvent): void {
  if (ev.source !== window) return;
  const data = ev.data as { __webchatAgent?: string; text?: string; ts?: number } | null;
  if (!data || data.__webchatAgent !== 'clipboard-write') return;
  if (typeof data.text !== 'string') return;
  lastClipboardCapture = { text: data.text, ts: data.ts ?? Date.now() };
}

/** Try to harvest the assistant message's canonical markdown by clicking
 * DeepSeek's own "Copy" button: its handler hands the markdown to
 * navigator.clipboard.writeText, which our MAIN-world tap intercepts and
 * forwards via window.postMessage. Returns null if the button isn't there
 * or no clipboard event fires within `timeoutMs`. */
async function captureMarkdownViaCopy(
  messageItem: HTMLElement,
  timeoutMs = 1500,
): Promise<string | null> {
  const btn = findCopyButtonIn(messageItem);
  if (!btn) {
    log(SCOPE, 'captureMarkdownViaCopy: no copy button found');
    return null;
  }
  const before = lastClipboardCapture?.ts ?? 0;
  try {
    btn.click();
  } catch (e) {
    warn(SCOPE, 'copy button .click() threw', e);
    return null;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastClipboardCapture && lastClipboardCapture.ts > before) {
      return lastClipboardCapture.text;
    }
    await sleep(40);
  }
  log(SCOPE, 'captureMarkdownViaCopy: timed out waiting for clipboard tap');
  return null;
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
    regenerateHandle: null,
    regenerateCount: 0,
    stoppedSuppressUntil: 0,
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
    // Check for "Stopped" — DeepSeek's thinking ended without producing a
    // response. Suppressed for STOPPED_COOLDOWN_MS after a regenerate
    // click so we don't loop on the prior attempt's residual span.
    if (Date.now() >= watch.stoppedSuppressUntil && findStoppedIndicatorIn(el)) {
      onStopped(el);
      return;
    }
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

  function onStopped(messageEl: HTMLElement): void {
    if (watch.regenerateCount >= STOPPED_REGEN_BACKOFFS_MS.length) {
      finishWithError(
        'stopped_exhausted',
        `DeepSeek stopped generation ${watch.regenerateCount} times.`,
      );
      return;
    }
    const wait = STOPPED_REGEN_BACKOFFS_MS[watch.regenerateCount];
    watch.regenerateCount += 1;
    watch.phase = 'stopped_waiting';
    if (watch.stabilityHandle) {
      clearTimeout(watch.stabilityHandle);
      watch.stabilityHandle = null;
    }
    log(
      SCOPE,
      `chatbot stopped detected — regenerate ${watch.regenerateCount}/${STOPPED_REGEN_BACKOFFS_MS.length} in ${wait}ms`,
    );
    void sendBusy(watch.sessionId, watch.iterationId, watch.regenerateCount, wait, 'stopped');
    watch.regenerateHandle = setTimeout(() => {
      if (watch.phase !== 'stopped_waiting') return;
      // Re-resolve the message item each time — virtual scrolling may have
      // re-rendered it. Fall back to the captured element if that fails.
      const fresh = findLatestAssistantMessage(watch.baselineKey) ?? messageEl;
      const btn = findRegenerateButtonIn(fresh);
      if (!btn) {
        finishWithError('stopped_exhausted', 'Regenerate button not found');
        return;
      }
      log(SCOPE, 'clicking DeepSeek regenerate button');
      btn.click();
      // Reset observer state so the next attempt is detected fresh, and
      // suppress further Stopped checks until the cool-down expires.
      watch.lastSnapshot = '';
      watch.stoppedSuppressUntil = Date.now() + STOPPED_COOLDOWN_MS;
      watch.phase = 'observing';
    }, wait);
  }

  function finishWithError(
    reason: 'busy_exhausted' | 'stopped_exhausted' | 'timeout' | 'unknown',
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
    void completeStable();
  }

  async function completeStable(): Promise<void> {
    const el = findLatestAssistantMessage(watch.baselineKey);
    if (!el) {
      logError(SCOPE, 'finish: no assistant element');
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

    // PRIMARY: click DeepSeek's own "Copy" button — its handler hands the
    // canonical markdown to navigator.clipboard.writeText, which our
    // MAIN-world tap captures via postMessage. This gives a perfect
    // markdown string (code fences with language tags, proper headings /
    // lists / etc.) without us having to reverse-engineer the DOM.
    let rawMd = '';
    let source: 'copy' | 'dom' | 'empty' = 'empty';
    const copied = await captureMarkdownViaCopy(el);
    if (copied && copied.trim().length > 0) {
      rawMd = copied;
      source = 'copy';
    } else if (assistantBody) {
      rawMd = extractMarkdownFromDom(assistantBody);
      source = 'dom';
    }
    const reasoning = thinkBody ? extractMarkdownFromDom(thinkBody) : '';
    const parsed = parseAgentCommands(rawMd);
    log(SCOPE, `finish via ${source}`, {
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
    if (watch.regenerateHandle) clearTimeout(watch.regenerateHandle);
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
  if (activeWatch.regenerateHandle) clearTimeout(activeWatch.regenerateHandle);
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
  reason: 'busy' | 'stopped' = 'busy',
): Promise<void> {
  const maxRetries =
    reason === 'stopped' ? STOPPED_REGEN_BACKOFFS_MS.length : BUSY_RETRY_BACKOFFS_MS.length;
  const evt: ChatbotBusyEvt = {
    type: 'CHATBOT_BUSY',
    sessionId,
    iterationId,
    retryCount,
    maxRetries,
    nextRetryInMs,
    reason,
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
