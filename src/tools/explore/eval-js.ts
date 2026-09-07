import { cli } from '@base/runtime/registry.js';
import { getActiveExploreSession } from '../../explore/session';

/**
 * Explore-time REPL: run a JS snippet in the explore tab and return its result,
 * through the **same execution path the synthesized adapter will use** — the
 * explore session's PageShim → CDP `Runtime.evaluate`, MAIN world, page CSP
 * bypassed, the user's login state intact. So the agent can develop + test the
 * exact extraction snippet live, confirm it captures the data, then bake that
 * proven snippet into `synthesize_adapter` (pass it in `notes`). Explore only.
 *
 * Write guard (F-29): eval_js is a MAIN-world channel with the user's login
 * cookies — an agent exploring a WRITE task ("star this repo") would otherwise
 * `fetch('/star',{method:'POST'})` and cause a REAL side effect mid-exploration,
 * bypassing every write-confirm (those only gate `access:'write'` adapters, and
 * eval_js is `read`). So in explore mode we statically detect obvious network
 * writes and refuse by default — the agent should OBSERVE the write's shape
 * (form action/method, CSRF token) to synthesize, not execute it. An explicit
 * `allow_write:true` is the escape hatch (only when the user asked to verify).
 */

// The static write guard lives in tools/generic/_eval-write-guard.ts so the
// localmd Connect eval_js (tools/generic/eval-js-localmd.ts) shares it without
// importing this file (which would drag the explore session into that bundle).
// Re-exported: tests and submission-capture import it from here.
import { detectWriteIntent } from '@base/tools/generic/_eval-write-guard';
export { detectWriteIntent };

cli({
  site: 'generic',
  name: 'eval_js',
  access: 'read',
  description:
    '[Explore mode only] Run a snippet of JS in the Explore tab and return the result (exactly the same execution channel as page.evaluate in a synthesized adapter: via CDP, bypassing page CSP, running in the MAIN world with the logged-in session). **Use it first to get your extraction code working** (test selectors, develop the full extraction snippet, confirm you really get the data you want) before synthesize_adapter, then put the working snippet into synthesize_adapter notes — the synthesizer will adopt it directly. The code must return a JSON-serializable value.',
  args: [
    {
      name: 'code',
      type: 'string',
      required: true,
      help: 'JS snippet; write `return ...;` or a single expression. Runs in the page and must return a JSON-serializable value',
    },
    {
      name: 'max_chars',
      type: 'int',
      default: 8000,
      help: 'Max characters of the result to return (default 8000, cap 200000)',
    },
    {
      name: 'allow_write',
      type: 'bool',
      help: 'Default false. By default eval_js refuses to execute an obvious write request (POST/PUT/DELETE/form submit) — when exploring a write task you should **observe** the write-endpoint shape for synthesis, not actually submit. Set true only when the user explicitly asks to "run one verification"',
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const session = getActiveExploreSession();
    if (!session) {
      return {
        ok: false,
        error: 'no active explore session — eval_js is only available while an explore recording is in progress',
      };
    }
    const code = typeof kwargs.code === 'string' ? kwargs.code : '';
    if (!code.trim()) return { ok: false, error: 'code must not be empty' };

    // Write guard (F-29): refuse an obvious network write unless explicitly
    // allowed. Exploring a write task should OBSERVE the write's shape, not
    // execute it — executing here is a real side effect that no confirm gated.
    // Scope note (audit Tier3-#17): this covers eval_js's DIRECT network writes
    // only. Generic action tools (click / type_into submit) can also cause a
    // page-side write (form submit) and are deliberately NOT gated — they're the
    // agent operating the page under user direction, not a synthesized adapter's
    // write; gating every submit-capable click would cripple normal interaction.
    // capture_submission is the safe path for OBSERVING a write during explore.
    const writeSignal = detectWriteIntent(code);
    if (writeSignal && !kwargs.allow_write) {
      return {
        ok: false,
        error:
          `Blocked: this code looks like it initiates a write request (${writeSignal}). When exploring a write task, **do not hard-submit via eval_js** — ` +
          `to **safely collect real evidence** (get the real request structure for synthesis), use **capture_submission**: action:"arm" to start intercepting, then really click submit (the request is neutralized, never sent to the server), then action:"disarm" to retrieve the structure — safer than a hard eval_js submit, and it captures the body fields/endpoint. ` +
          `Or fall back to **observing**: get_interactives / get_html for the trigger point (form action, method, where the CSRF token comes from) + read_network for the same kind of write this site has already made, and infer the synthesis from that. ` +
          `The synthesized write adapter is "untested"; it is verified when the user invokes it in chat via write-confirmation — which is correct. Only if you truly need eval_js to run one verification (and only when the user explicitly asks) set allow_write:true.`,
      };
    }
    const maxChars = Math.max(200, Math.min(Number(kwargs.max_chars ?? 8000) || 8000, 200000));
    const page = await session.newPage();
    try {
      const result = await page.evaluate(code);
      // If the agent just extracted an array, keep it (plus the code that
      // produced it) as differential ground truth (A1) + the proven snippet fed
      // to synthesis (D4) — the adapter should reproduce roughly this.
      if (Array.isArray(result)) session.recordExtraction(result, code);
      let serialized: string;
      if (result === undefined) serialized = 'undefined';
      else if (typeof result === 'string') serialized = result;
      else {
        try {
          serialized = JSON.stringify(result, null, 2);
        } catch {
          serialized = String(result);
        }
      }
      const truncated = serialized.length > maxChars;
      return {
        ok: true,
        resultType: Array.isArray(result) ? `array(${result.length})` : typeof result,
        truncated,
        result: truncated ? serialized.slice(0, maxChars) + '\n…[truncated]' : serialized,
      };
    } catch (e) {
      // Don't throw — eval errors are expected while the agent iterates; return
      // them so it can fix the snippet without tripping the thrash breaker.
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      try {
        await page.detach(); // no-op: the session owns the CDP attachment
      } catch {
        /* ignore */
      }
    }
  },
});
