/**
 * Cockpit-mask registry (A, page-agent-comparison §4.3.6): which tabs the
 * agent is currently driving, so the in-page persistent mask's MASK_PING
 * heartbeat can be answered truthfully.
 *
 * Lifecycle contract:
 *  - the dispatcher arms every tab a tool touches (open_url included → the
 *    mask is up from the moment a tab joins the run, and stays up through LLM
 *    thinking gaps thanks to the ping);
 *  - `requestHumanTakeover` releases the target tab (the user is about to
 *    operate it themselves);
 *  - engine-driver releases everything when the last session ends;
 *  - the registry is IN-MEMORY on purpose: an SW restart wipes it, pings get
 *    alive:false, masks self-disarm — a crashed run can never leave a page
 *    blocked.
 */

import {
  agentCursorInPage,
  agentMaskReleaseInPage,
  MASK_ARM_MS,
} from '@base/tools/generic/_agent-cursor';

/** With no active session (bridge-driven work has no run-end signal), a tab's
 * mask stays answerable this long after its last tool touch. */
export const MASK_IDLE_MS = 45_000;

/** tabId → last time a tool touched it. */
const maskTabs = new Map<number, number>();

export function noteMaskArmed(tabId: number, now = Date.now()): void {
  maskTabs.set(tabId, now);
  if (maskTabs.size > 50) {
    const oldest = maskTabs.keys().next().value;
    if (oldest !== undefined) maskTabs.delete(oldest);
  }
}

/** Answer for a MASK_PING from `tabId`. While a session runs, every registered
 * tab stays alive (thinking gaps included); session-less drivers (bridge) fall
 * back to the idle window. Pure given `now` — unit-tested. */
export function isMaskAlive(tabId: number, anySessionActive: boolean, now = Date.now()): boolean {
  const last = maskTabs.get(tabId);
  if (last === undefined) return false;
  return anySessionActive || now - last < MASK_IDLE_MS;
}

/** Fire-and-forget: ensure the persistent mask is up on `tabId` (no cursor
 * movement — arm-only). Always on — the cockpit is a fixed part of the
 * product, not a setting (user decision). */
export async function armAgentMask(tabId: number): Promise<void> {
  try {
    noteMaskArmed(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: agentCursorInPage,
      args: [-1, -1, '', 0, 0, true, MASK_ARM_MS, true],
    });
  } catch {
    /* best-effort — restricted page / tab gone */
  }
}

/** Instantly release one tab (human takeover: the user must be able to click). */
export async function releaseMask(tabId: number): Promise<void> {
  maskTabs.delete(tabId);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: agentMaskReleaseInPage });
  } catch {
    /* tab gone — its mask died with it */
  }
}

/** Release every registered tab (last session ended). */
export async function releaseAllMasks(): Promise<void> {
  const ids = [...maskTabs.keys()];
  maskTabs.clear();
  await Promise.allSettled(
    ids.map((id) =>
      chrome.scripting.executeScript({ target: { tabId: id }, func: agentMaskReleaseInPage }),
    ),
  );
}

/** Test hook. */
export function resetMaskRegistryForTests(): void {
  maskTabs.clear();
}
