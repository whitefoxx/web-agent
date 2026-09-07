import { cli } from '@base/runtime/registry.js';
import { assertTabId } from '@base/tools/generic/_helpers';
import { getActiveExploreSession } from '../../explore/session';
import {
  armSubmissionCapture,
  type SubmissionCaptureHandle,
} from '../../runtime/submission-capture';

/**
 * Explore-time SAFE write capture — the constructive answer to F-29
 * (docs/browseract-comparison.md ①). Instead of `eval_js` merely refusing an
 * obvious write, the agent ARMS capture, then genuinely fills the form and
 * clicks submit: the write request (POST/PUT/PATCH/DELETE / GraphQL mutation) is
 * intercepted, its full structure recorded, and it is NEUTRALIZED so it never
 * reaches the server — zero side effect. DISARM returns the captured request(s)
 * (cookie/auth headers redacted) and records them into the explore trace, so a
 * WRITE adapter can be synthesized from real evidence and later verified by the
 * user through the write-confirm gate.
 *
 * Scope: only the ONE controlled tab (CDP `chrome.debugger` is per-target — not
 * the browser, not other tabs, not other software, not the OS). Reads pass
 * through untouched while armed. Explore tab by default; a tab_id works
 * standalone (for fixtures / bridge verification).
 */

// Per-tab live capture handles, spanning the arm→(clicks)→disarm tool calls.
const armed = new Map<number, SubmissionCaptureHandle>();

cli({
  site: 'generic',
  name: 'capture_submission',
  access: 'read',
  description:
    '[Explore · safe write-task capture] Lets you **actually fill the form + click submit** during an explore write op, but intercepts the write request (POST/PUT/PATCH/DELETE / GraphQL mutation), captures its full structure, and **neutralizes it (never sent to the server, zero side effects)**; read requests pass through as usual. Only affects the **single** tab being driven (does not touch other tabs / other software / system networking). Usage: action:"arm" to start intercepting → use click/type_into to really submit → action:"disarm" to retrieve the neutralized write-request structure (cookie/auth headers redacted), then synthesize_adapter to build a write adapter (status "untested"; verified when the user invokes it via write-confirmation). This makes explore write tasks both safe and able to collect the evidence synthesis needs, replacing "observe only, afraid to act". Omit tab_id to use the explore session tab.',
  args: [
    {
      name: 'action',
      type: 'string',
      required: true,
      help: '"arm" start intercepting | "disarm" stop and return the captured write requests | "status" view what has been captured so far (without stopping)',
    },
    { name: 'tab_id', type: 'int', help: 'target tab; omit to use the explore session tab' },
    {
      name: 'mode',
      type: 'string',
      default: 'abort',
      help: 'How to neutralize the write request: "abort" (default; the page will see a network error — this is expected, not a task failure) | "fulfill" (return a fake 200 {ok:true} so the page shows its success UI, useful for continuing a multi-step flow). Neither is ever actually sent',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    let tabId: number;
    if (kwargs.tab_id !== undefined && kwargs.tab_id !== null && kwargs.tab_id !== '') {
      await assertTabId(kwargs.tab_id);
      tabId = Number(kwargs.tab_id);
    } else if (session) {
      tabId = session.tabId;
    } else {
      return { ok: false, error: 'provide tab_id, or start an explore session first' };
    }
    const action = String(kwargs.action ?? '')
      .trim()
      .toLowerCase();

    if (action === 'arm') {
      if (armed.has(tabId)) {
        return {
          ok: false,
          error: `tab ${tabId} is already capturing; disarm to retrieve results first, or use status to inspect`,
        };
      }
      const mode = kwargs.mode === 'fulfill' ? 'fulfill' : 'abort';
      try {
        const handle = await armSubmissionCapture(tabId, { mode });
        armed.set(tabId, handle);
      } catch (e) {
        return { ok: false, error: `arm failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      return {
        ok: true,
        armed: true,
        tab_id: tabId,
        mode,
        note: 'Interception is on. Now **really** fill the form + click submit (with click / type_into / press_key) — the write request will be intercepted, recorded, and neutralized (never sent to the server). When done, call disarm to retrieve the captured request structure.',
      };
    }

    if (action === 'status') {
      const handle = armed.get(tabId);
      if (!handle) return { ok: true, armed: false, count: 0, captured: [] };
      return { ok: true, armed: true, count: handle.captured.length, captured: handle.captured };
    }

    if (action === 'disarm') {
      const handle = armed.get(tabId);
      if (!handle) {
        return { ok: false, error: `tab ${tabId} is not capturing (arm first)` };
      }
      let captured;
      try {
        captured = await handle.stop();
      } finally {
        armed.delete(tabId);
      }
      // Feed the captured writes into the explore trace so synthesis sees the
      // real request structure (mirrors how eval_js records the proven snippet).
      if (session && session.tabId === tabId && captured.length) {
        session.recordSubmission(captured);
      }
      return {
        ok: true,
        disarmed: true,
        count: captured.length,
        captured,
        note: captured.length
          ? 'These are the neutralized write requests (never sent, cookie/auth headers redacted). Use them to synthesize a write adapter: endpoint + method + body field names (for GraphQL, the mutation name). The synthesized write adapter will be "untested"; verification is left to the user invoking it in chat via write-confirmation — which is correct.'
          : 'No write request captured. Possible reasons: you have not clicked the real submit yet, the submission went through a channel this tool does not intercept, or the action has no network write at all. Check and retry, or switch to get_interactives/read_network to observe the write-endpoint shape.',
      };
    }

    return { ok: false, error: 'action must be "arm" / "disarm" / "status"' };
  },
});
