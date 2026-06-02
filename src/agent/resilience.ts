/**
 * Resilience primitives for the agent loop — bounded retry with backoff for
 * transient LLM-API faults, and a thrash breaker that stops the loop when it
 * gets stuck repeating a failing tool call.
 *
 * Why this exists (see docs/agent-harness.md §10.1): a long agent loop (dozens
 * of tool calls) used to die on the FIRST transient hiccup — `api-engine` did
 * `finish('error')` the moment a single fetch threw or returned a 5xx/429, so
 * one network blip at step 25 killed the whole session. And a model that keeps
 * re-issuing the same failing call would burn the entire step budget. These
 * helpers let the loop survive transient faults and bail out of dead-ends.
 *
 * Everything here is pure or takes its randomness/clock as an argument, so it
 * unit-tests deterministically — see tests/resilience.test.ts.
 */

export interface RetryPolicy {
  /** Total attempts INCLUDING the first try. */
  maxAttempts: number;
  /** Base backoff; grows ~exponentially per attempt. */
  baseDelayMs: number;
  /** Hard ceiling on any single backoff wait. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 600,
  maxDelayMs: 8_000,
};

/** Transient HTTP statuses worth retrying. Other 4xx are caller errors — a 400
 * bad-request or 401 auth won't fix itself, so we DON'T retry them (retrying
 * just delays the error the user needs to see). 408 (timeout) and 429 (rate
 * limit) are the retriable 4xx. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** A network-layer failure (DNS, connection reset, fetch "failed to fetch") is
 * transient → retry. An AbortError (user hit Stop) is NOT — propagate it so the
 * loop ends promptly. `fetch` surfaces network failures as a TypeError. */
export function isRetriableNetworkError(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return false;
  return e instanceof TypeError;
}

/** Parse a `Retry-After` header: either delta-seconds ("120") or an HTTP-date.
 * Returns seconds-from-now (never negative), or undefined if absent/garbage.
 * `now` is injectable for deterministic tests. */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, (when - now) / 1000);
  return undefined;
}

/** Backoff for `attempt` (0-based). Honors a server-provided `retryAfterSec`
 * when present (capped to maxDelayMs); otherwise exponential base·2^attempt
 * with full jitter in [50%,100%] to avoid thundering-herd retries. `rand`
 * (0..1) is injected so tests are deterministic — production passes
 * Math.random(). */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterSec?: number,
  rand: number = Math.random(),
): number {
  if (retryAfterSec != null && retryAfterSec >= 0) {
    return Math.min(Math.round(retryAfterSec * 1000), policy.maxDelayMs);
  }
  const exp = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  return Math.round(exp * (0.5 + 0.5 * rand));
}

/** Promise that resolves after `ms`, or rejects with an AbortError if `signal`
 * fires first — so a retry wait is interruptible by Stop instead of blocking
 * the abort for up to maxDelayMs. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Stable key for a (tool, args) pair, used to detect repeated identical calls.
 * Tolerant of unserializable args (falls back to String). */
export function toolCallKey(tool: string, args: unknown): string {
  let a: string;
  try {
    a = JSON.stringify(args ?? {});
  } catch {
    a = String(args);
  }
  return `${tool}:${a}`;
}

export interface ThrashConfig {
  /** Break after this many CONSECUTIVE failures of the same (tool,args). */
  maxSameFailure: number;
}

export const DEFAULT_THRASH: ThrashConfig = { maxSameFailure: 3 };

/**
 * Tracks consecutive same-call failures so the loop can break out of a dead-end
 * (a model re-issuing a call that keeps failing) instead of burning the whole
 * step budget. A success on a key clears its streak. Stateful but tiny — one
 * instance per session run.
 *
 * The complementary "no plan progress for N turns" breaker lands with the plan
 * artifact (Phase 1), since it needs plan-step state to measure progress.
 */
export class ThrashTracker {
  private readonly streak = new Map<string, number>();
  constructor(private readonly cfg: ThrashConfig = DEFAULT_THRASH) {}

  /** Record a tool outcome. Returns a human-readable breaker reason when the
   * same call has failed `maxSameFailure` times in a row, else null. */
  record(key: string, ok: boolean): string | null {
    if (ok) {
      this.streak.delete(key);
      return null;
    }
    const n = (this.streak.get(key) ?? 0) + 1;
    this.streak.set(key, n);
    if (n >= this.cfg.maxSameFailure) {
      return `同一工具调用连续失败 ${n} 次,已熔断以避免空转(${key.slice(0, 100)})。`;
    }
    return null;
  }
}

export interface NoProgressConfig {
  /** Break after this many consecutive turns with NO plan progress AND NO
   * successful tool call. */
  maxStalls: number;
}

export const DEFAULT_NO_PROGRESS: NoProgressConfig = { maxStalls: 8 };

/**
 * Detects a stalled run: with an approved plan, N turns in a row where neither
 * the completed-step count rose NOR any tool call succeeded — i.e. genuinely
 * stuck, not merely a hard step. The double condition is deliberately
 * conservative, so a legitimately long single step (many successful tool calls
 * before its step completes) never trips it. One instance per run.
 */
export class NoProgressTracker {
  private stalls = 0;
  private lastCompleted = 0;
  constructor(private readonly cfg: NoProgressConfig = DEFAULT_NO_PROGRESS) {}

  /** Record a turn. `completed` = plan steps done so far; `anyToolSuccess` =
   * whether any dispatched tool succeeded this turn. Returns a breaker reason
   * once stalled `maxStalls` turns, else null. */
  record(completed: number, anyToolSuccess: boolean): string | null {
    if (completed > this.lastCompleted || anyToolSuccess) {
      this.lastCompleted = Math.max(this.lastCompleted, completed);
      this.stalls = 0;
      return null;
    }
    this.stalls += 1;
    if (this.stalls >= this.cfg.maxStalls) {
      return `已连续 ${this.stalls} 轮无计划进展、也无成功操作,疑似卡住,先暂停。`;
    }
    return null;
  }
}
