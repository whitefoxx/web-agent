/**
 * Page↔LLM bridge (roadmap H11, P1) — lets a site script's injected js call the
 * extension's LLM through `__webLLM.call(prompt, {system})`, unlocking
 * in-page continuous intelligence (side-by-side bilingual translation, in-page
 * summary overlays, writing assistance…) with ZERO new permissions.
 *
 * Channel & trust boundary: site scripts run in the USER_SCRIPT world;
 * `userScripts.configureWorld({messaging:true})` enables
 * `chrome.runtime.sendMessage` there, delivered via the DEDICATED
 * `chrome.runtime.onUserScriptMessage` event — a page's own MAIN-world JS
 * cannot reach that event (web pages need externally_connectable for
 * runtime messaging, which we don't declare). On top of the channel, every
 * call is validated: the script must exist, be enabled and hold `llmAccess`
 * (granted through the same explicit user confirm as `js` itself), and the
 * SENDING TAB's URL must match the script's `matches` patterns.
 *
 * Abuse limits (page content is untrusted input — treat prompts like tool
 * results, never like instructions to obey): prompt/system size caps, per-
 * script sliding windows (30/5min, 300/day), a small global concurrency cap,
 * bounded max_tokens and a hard timeout. See docs/page-llm-bridge.md.
 */

import { chatCompletion } from '../agent/chat-completion';
import { resolveSlots, needsBaseUrl } from '../config/llm-config';
import { getSiteScript } from '@base/site-scripts/store';
import { log, warn } from '@base/runtime/log';

const SCOPE = 'page-llm';

export const PAGE_LLM_PROMPT_MAX = 6_000;
export const PAGE_LLM_SYSTEM_MAX = 1_000;
const MAX_TOKENS = 1_000;
const TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 3;
const PER_5MIN = 30;
const PER_DAY = 300;

/** Sliding-window rate limiter. PURE (caller passes `now`); unit-tested. */
export class SlidingWindowLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Record + admit an event at `now`; false = over the limit (not recorded). */
  allow(now: number): boolean {
    const cutoff = now - this.windowMs;
    if (this.hits.length && this.hits[0]! <= cutoff) {
      this.hits = this.hits.filter((t) => t > cutoff);
    }
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** Does `url` match one of the chrome match patterns? Mirrors chrome's
 * semantics for the subset our validator admits (`<scheme>://<host><path>`,
 * host `*` / `*.domain` / `domain`, `*` wildcards in the path). PURE. */
export function urlMatchesPatterns(url: string, patterns: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(/:$/, '');
  const host = u.hostname;
  const path = u.pathname + u.search;
  for (const p of patterns) {
    if (p === '<all_urls>') return true; // not creatable via our validator; defensive
    const m = /^(\*|https?|file|ftp):\/\/(\*|(?:\*\.)?[^/*:]+)(\/.*)$/.exec(p);
    if (!m) continue;
    const [, ps, ph, pp] = m as unknown as [string, string, string, string];
    if (ps === '*' ? !/^https?$/.test(scheme) : ps !== scheme) continue;
    if (ph !== '*') {
      if (ph.startsWith('*.')) {
        const base = ph.slice(2);
        if (host !== base && !host.endsWith(`.${base}`)) continue;
      } else if (host !== ph) {
        continue;
      }
    }
    const pathRe = new RegExp(`^${pp.split('*').map(escapeRe).join('.*')}$`);
    if (pathRe.test(path) || pathRe.test(u.pathname)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PageLlmCallMsg {
  type?: string;
  scriptId?: unknown;
  prompt?: unknown;
  system?: unknown;
  /** true → the caller wants machine-parseable JSON: the SW nudges the model
   * and strips fences/prose centrally (extractJsonPayload) so page scripts can
   * `JSON.parse` the result directly. Born from F-38: the HN-translate agent
   * script failed 3 rounds on fence-wrapped JSON before giving up on JSON. */
  json?: unknown;
}

/** Extract the JSON value from a model reply that may wrap it in a markdown
 * fence or surrounding prose. Returns a string that JSON.parse accepts, or
 * null when nothing parseable is found (caller falls back to the raw text).
 * Mirrors the repair ladder of engine-history's parseToolArgs. PURE. */
export function extractJsonPayload(raw: string): string | null {
  const tryParse = (s: string): string | null => {
    const t = s.trim();
    if (!t) return null;
    try {
      JSON.parse(t);
      return t;
    } catch {
      return null;
    }
  };
  const direct = tryParse(raw);
  if (direct) return direct;
  // ```json ... ``` fence (or bare ```)
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1]);
    if (fenced) return fenced;
  }
  // first [...] or {...} block inside prose (greedy to the LAST bracket so
  // nested structures survive; validate before accepting)
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const a = raw.indexOf(open);
    const b = raw.lastIndexOf(close);
    if (a >= 0 && b > a) {
      const block = tryParse(raw.slice(a, b + 1));
      if (block) return block;
    }
  }
  return null;
}

export interface PageLlmResp {
  ok: boolean;
  text?: string;
  error?: string;
}

const perScript = new Map<string, { win: SlidingWindowLimiter; day: SlidingWindowLimiter }>();
let inFlight = 0;

function limitersFor(id: string): { win: SlidingWindowLimiter; day: SlidingWindowLimiter } {
  let l = perScript.get(id);
  if (!l) {
    l = {
      win: new SlidingWindowLimiter(PER_5MIN, 5 * 60_000),
      day: new SlidingWindowLimiter(PER_DAY, 24 * 3600_000),
    };
    perScript.set(id, l);
  }
  return l;
}

/** Validate + execute one bridge call. Never throws (always a PageLlmResp). */
export async function handlePageLlmCall(
  msg: PageLlmCallMsg,
  sender: { tab?: { url?: string }; url?: string },
): Promise<PageLlmResp> {
  const scriptId = typeof msg.scriptId === 'string' ? msg.scriptId : '';
  const prompt =
    typeof msg.prompt === 'string' ? msg.prompt.trim().slice(0, PAGE_LLM_PROMPT_MAX) : '';
  const wantJson = msg.json === true;
  let system =
    typeof msg.system === 'string' && msg.system.trim()
      ? msg.system.trim().slice(0, PAGE_LLM_SYSTEM_MAX)
      : undefined;
  if (wantJson) {
    // Centralized JSON discipline (F-38): nudge here + strip fences below, so
    // page scripts never re-invent fence/prose tolerance.
    const hint = 'Output only the JSON itself: no markdown code block, no explanatory text.';
    system = system ? `${system}\n${hint}` : hint;
  }
  if (!scriptId || !prompt) return { ok: false, error: 'Incomplete request (scriptId/prompt)' };

  const s = await getSiteScript(scriptId);
  if (!s || !s.enabled || !s.llmAccess) {
    return { ok: false, error: 'This site script does not exist, is disabled, or lacks LLM access' };
  }
  // The call must originate from a tab the script is registered on — a stolen
  // scriptId is useless from anywhere else.
  const url = sender.tab?.url ?? sender.url ?? '';
  if (!url || !urlMatchesPatterns(url, s.matches)) {
    return { ok: false, error: 'The originating page is outside this script\'s match range' };
  }
  const now = Date.now();
  const lim = limitersFor(scriptId);
  if (!lim.day.allow(now) || !lim.win.allow(now)) {
    return {
      ok: false,
      error: `Call rate limit exceeded (${PER_5MIN}/5 min / ${PER_DAY}/day)`,
    };
  }
  if (inFlight >= MAX_CONCURRENT) {
    return { ok: false, error: 'Concurrency limit reached, try again shortly' };
  }
  const { primary } = await resolveSlots();
  if (!primary?.apiKey || (needsBaseUrl(primary.provider) && !primary.baseUrl)) {
    return { ok: false, error: 'No primary-model API Key configured (side panel → menu → LLM config)' };
  }

  inFlight++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await chatCompletion({
      apiKey: primary.apiKey,
      baseUrl: primary.baseUrl,
      provider: primary.provider,
      body: {
        model: primary.model,
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: prompt },
        ],
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
      },
      signal: ctl.signal,
    });
    let text = resp.choices?.[0]?.message?.content?.trim();
    if (text && wantJson) {
      const cleaned = extractJsonPayload(text);
      if (cleaned) text = cleaned;
      else
        return {
          ok: false,
          error: 'The model returned no parseable JSON (tried stripping code blocks / extracting fragments)',
        };
    }
    log(SCOPE, `bridge call ok script=${scriptId}`, { in: prompt.length, out: text?.length ?? 0 });
    return text ? { ok: true, text } : { ok: false, error: 'The model returned no content' };
  } catch (e) {
    warn(SCOPE, 'bridge call failed', e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
}

/** Wire the bridge at SW boot: enable USER_SCRIPT-world messaging and listen on
 * the dedicated onUserScriptMessage channel. Best-effort — absent APIs (older
 * Chrome / "Allow user scripts" off / tests) just leave the bridge dark. */
export function initPageLlmBridge(): void {
  try {
    const rt = chrome.runtime as unknown as {
      onUserScriptMessage?: {
        addListener(
          fn: (
            m: unknown,
            sender: chrome.runtime.MessageSender,
            sendResponse: (r: PageLlmResp) => void,
          ) => boolean | undefined,
        ): void;
      };
    };
    if (!rt.onUserScriptMessage) {
      warn(SCOPE, 'onUserScriptMessage unavailable — bridge disabled');
      return;
    }
    rt.onUserScriptMessage.addListener((m, sender, sendResponse) => {
      if ((m as PageLlmCallMsg | null)?.type !== 'PAGE_LLM_CALL') return undefined;
      void handlePageLlmCall(m as PageLlmCallMsg, sender).then(sendResponse, (e) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      return true; // async sendResponse
    });
    const usApi = (
      globalThis as {
        chrome?: {
          userScripts?: { configureWorld?: (o: { messaging: boolean }) => Promise<void> };
        };
      }
    ).chrome?.userScripts;
    void usApi?.configureWorld?.({ messaging: true })?.catch((e) => {
      warn(SCOPE, 'configureWorld failed (bridge calls will not arrive)', e);
    });
    log(SCOPE, 'page↔LLM bridge ready');
  } catch (e) {
    warn(SCOPE, 'initPageLlmBridge failed', e);
  }
}
