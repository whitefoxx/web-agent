/**
 * The three "pause the run and ask the panel" flows, which all share one shape:
 * send a `*_REQ` to the SidePanel, park a resolver in a Map keyed by an id, and
 * resolve it when the matching `*_RESP` arrives (or on timeout / abort).
 *
 *   - write-confirm   — gate a `write` adapter behind explicit approval.
 *   - human-takeover  — H9: a login/auth wall the user can pass but the agent can't.
 *   - plan-decision   — plan mode: approve the proposed plan before acting.
 *
 * All state here is in-memory (lost on SW recycle); the timeouts below bound how
 * long a parked prompt can hang before it auto-resolves to "declined".
 */

import { log, warn } from '@base/runtime/log';
import type { PlanState } from '../agent/plan';
import { sendToSidepanel } from '@base/background/runtime-state';
import { activeSessions } from './active-sessions';
import { releaseMask } from './mask-keeper';
import type {
  WriteConfirmReq,
  WriteConfirmResp,
  HumanTakeoverReq,
  HumanTakeoverResp,
  PlanDecisionReq,
  PlanDecisionResp,
  PlanDecision,
  AwaitResumeHint,
} from '../messages';

const SCOPE = 'sw';

/** SidePanel-bound write-confirm prompts. Resolves true on approval,
 * false on decline / timeout / panel close. */
const pendingConfirmations = new Map<string, { resolve: (approved: boolean) => void }>();
const WRITE_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/** SidePanel-bound human-takeover prompts (H9): a tool hit a login/auth wall —
 * pause, ask the user to take over the focused tab, resume on their decision.
 * Resolves true (retry the tool) or false (give up: decline / timeout / close). */
const pendingTakeovers = new Map<string, { resolve: (resume: boolean) => void }>();
const TAKEOVER_TIMEOUT_MS = 5 * 60 * 1000;

/** SidePanel-bound plan-approval prompts (plan mode). Resolves with the user's
 * decision; rejects on timeout / panel close. */
const pendingPlanDecisions = new Map<string, { resolve: (d: PlanDecision) => void }>();
const PLAN_DECISION_TIMEOUT_MS = 10 * 60 * 1000;

/* ───────── write-confirm ───────── */

/** Ask the SidePanel for explicit user approval before running a write
 * adapter. Returns true on approve, false on decline / timeout. */
export function requestWriteConfirmation(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  description?: string,
): Promise<boolean> {
  const confirmId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  log(SCOPE, `requesting write-confirm for ${tool}`, { confirmId, args });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingConfirmations.has(confirmId)) return;
      pendingConfirmations.delete(confirmId);
      warn(SCOPE, `write-confirm timeout confirmId=${confirmId}`);
      resolve(false);
    }, WRITE_CONFIRM_TIMEOUT_MS);
    pendingConfirmations.set(confirmId, {
      resolve: (approved: boolean) => {
        clearTimeout(timer);
        resolve(approved);
      },
    });
    const req: WriteConfirmReq = {
      type: 'WRITE_CONFIRM_REQ',
      sessionId,
      confirmId,
      tool,
      args,
      description,
    };
    sendToSidepanel(req);
  });
}

export function handleWriteConfirmResp(m: WriteConfirmResp): void {
  const pending = pendingConfirmations.get(m.confirmId);
  if (!pending) {
    warn(SCOPE, `unmatched WRITE_CONFIRM_RESP confirmId=${m.confirmId}`);
    return;
  }
  pendingConfirmations.delete(m.confirmId);
  log(SCOPE, `write confirm resolved confirmId=${m.confirmId}`, { approved: m.approved });
  pending.resolve(m.approved);
}

/* ───────── human takeover (H9) ───────── */

/** Best-effort: bring a tab (and its window) to the foreground so the user can
 * act on it during a human-takeover prompt. */
async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    warn(SCOPE, `focusTab failed tabId=${tabId}`, e);
  }
}

/** How often the ③b auto-resume poll checks the tab (below the manual-click
 * cadence; a sequential setTimeout loop so probes never overlap). */
const AUTO_RESUME_POLL_MS = 700;

/** Probe a tab for a selector, deep into open shadow DOM (login UIs are often web
 * components). Returns true/false, or null on a bad selector / dead tab (the poll
 * treats null as "not yet" and keeps waiting for the manual click / timeout). */
async function selectorPresent(tabId: number, selector: string): Promise<boolean | null> {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        try {
          let visited = 0;
          const walk = (root: Document | ShadowRoot): Element | null => {
            const direct = root.querySelector(sel);
            if (direct) return direct;
            const all = root.querySelectorAll('*');
            for (let i = 0; i < all.length; i++) {
              if (++visited > 12000) return null;
              const sr = (all[i] as HTMLElement).shadowRoot;
              if (sr) {
                const hit = walk(sr);
                if (hit) return hit;
              }
            }
            return null;
          };
          return { present: !!walk(document) };
        } catch {
          return { bad: true };
        }
      },
      args: [selector],
    });
    const r = res[0]?.result as { present?: boolean; bad?: boolean } | undefined;
    if (!r || r.bad) return null;
    return !!r.present;
  } catch {
    return null; // tab closed / not scriptable
  }
}

/** Pause the run and ask the user to take over a login/auth wall on `tabId` (we
 * focus it). Resolves true to retry the tool, false to surface the auth error.
 * If `autoResume` is given (③b), we ALSO poll the tab and resolve on our own the
 * moment its selector appears/disappears — so a login the agent can detect no
 * longer needs a manual "I'm done" click (the card still lets the user act). */
export function requestHumanTakeover(
  sessionId: string,
  tool: string,
  tabId?: number,
  domain?: string,
  message?: string,
  autoResume?: AwaitResumeHint,
): Promise<boolean> {
  const takeoverId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  log(SCOPE, `requesting human takeover for ${tool}`, { takeoverId, tabId, domain, message });
  if (typeof tabId === 'number') {
    // The user is about to operate this tab themselves — the cockpit mask must
    // get out of their way NOW (it would swallow the very clicks we're asking
    // them to make). The dispatcher re-arms it on the next agent tool call.
    void releaseMask(tabId);
    void focusTab(tabId);
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    // Single settle path — button, timeout, and auto-resume all funnel here, so
    // the timer AND the poll are always torn down exactly once. (`finish`
    // references `timer` in its closure, evaluated only when called — after the
    // `const timer` line has run — so the forward reference is safe.)
    const finish = (resume: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      pendingTakeovers.delete(takeoverId);
      resolve(resume);
    };
    const timer = setTimeout(() => {
      warn(SCOPE, `human-takeover timeout takeoverId=${takeoverId}`);
      finish(false);
    }, TAKEOVER_TIMEOUT_MS);
    pendingTakeovers.set(takeoverId, { resolve: finish });

    // ③b auto-resume poll (only with a tab to watch). Sequential setTimeout so a
    // slow probe never stacks; each tick re-checks `done` to stop cleanly.
    if (autoResume && typeof tabId === 'number') {
      const tick = async (): Promise<void> => {
        if (done) return;
        const present = await selectorPresent(tabId, autoResume.selector);
        if (done) return;
        const met =
          present === null ? false : autoResume.until === 'disappear' ? !present : present;
        if (met) {
          log(SCOPE, `human-takeover auto-resumed (${autoResume.until})`, {
            takeoverId,
            selector: autoResume.selector,
          });
          finish(true);
          return;
        }
        pollTimer = setTimeout(() => void tick(), AUTO_RESUME_POLL_MS);
      };
      pollTimer = setTimeout(() => void tick(), AUTO_RESUME_POLL_MS);
    }

    const req: HumanTakeoverReq = {
      type: 'HUMAN_TAKEOVER_REQ',
      sessionId,
      takeoverId,
      tool,
      tabId,
      domain,
      message,
      autoResume,
    };
    sendToSidepanel(req);
  });
}

export function handleHumanTakeoverResp(m: HumanTakeoverResp): void {
  const pending = pendingTakeovers.get(m.takeoverId);
  if (!pending) {
    warn(SCOPE, `unmatched HUMAN_TAKEOVER_RESP takeoverId=${m.takeoverId}`);
    return;
  }
  pendingTakeovers.delete(m.takeoverId);
  log(SCOPE, `human takeover resolved takeoverId=${m.takeoverId}`, { resume: m.resume });
  pending.resolve(m.resume);
}

/* ───────── plan decision (plan mode) ───────── */

/** Ask the SidePanel to approve a proposed plan before the agent leaves the
 * read-only planning phase (plan mode). Resolves with the decision; rejects on
 * timeout / panel close. Mirrors requestWriteConfirmation. */
export function requestPlanDecision(sessionId: string, plan: PlanState): Promise<PlanDecision> {
  const decisionId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  log(SCOPE, `requesting plan decision`, { decisionId, steps: plan.steps.length });
  const req: PlanDecisionReq = { type: 'PLAN_DECISION_REQ', sessionId, decisionId, plan };
  return new Promise<PlanDecision>((resolve) => {
    // Re-send the card request periodically. A single SW→panel message can be
    // dropped/raced under MV3 (or miss a panel that reloaded mid-run), which
    // would hang the whole run awaiting a decision the user was never shown.
    // The panel dedups by decisionId and ignores re-sends for a decided one. §10.19
    const resend = setInterval(() => sendToSidepanel(req), 3000);
    const timer = setTimeout(() => {
      if (!pendingPlanDecisions.has(decisionId)) return;
      pendingPlanDecisions.delete(decisionId);
      clearInterval(resend);
      warn(SCOPE, `plan-decision timeout ${decisionId}`);
      resolve({ decision: 'reject' });
    }, PLAN_DECISION_TIMEOUT_MS);
    const resolver = (d: PlanDecision): void => {
      clearTimeout(timer);
      clearInterval(resend);
      resolve(d);
    };
    pendingPlanDecisions.set(decisionId, { resolve: resolver });
    // The user Stopping (or a takeover) must unblock this await — otherwise the
    // run stays stuck in activeSessions and "Continue" hits "already running". §10.20
    const signal = activeSessions.get(sessionId)?.abort.signal;
    const onAbort = (): void => {
      if (!pendingPlanDecisions.has(decisionId)) return;
      pendingPlanDecisions.delete(decisionId);
      log(SCOPE, `plan-decision aborted ${decisionId}`);
      resolver({ decision: 'reject' });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    sendToSidepanel(req);
  });
}

export function handlePlanDecisionResp(m: PlanDecisionResp): void {
  const pending = pendingPlanDecisions.get(m.decisionId);
  if (!pending) {
    warn(SCOPE, `unmatched PLAN_DECISION_RESP decisionId=${m.decisionId}`);
    return;
  }
  pendingPlanDecisions.delete(m.decisionId);
  log(SCOPE, `plan decision resolved ${m.decisionId}`, { decision: m.decision });
  pending.resolve({ decision: m.decision, editedSteps: m.editedSteps, feedback: m.feedback });
}
