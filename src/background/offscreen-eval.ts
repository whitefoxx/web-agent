/**
 * Service-worker side of the offscreen eval venue (T7).
 *
 * Ensures a single offscreen document exists (creating it lazily) and asks it to
 * eval adapter source in its sandboxed iframe — so install / explore / ephemeral
 * `load_adapter` no longer require the SidePanel to be open. The offscreen doc
 * only relays to the opaque sandbox frame; the eval itself stays isolated.
 *
 * See src/offscreen/offscreen.ts (the relay) and src/sidepanel/sandbox-host.ts
 * (the iframe host, reused there).
 */

import type { SandboxEvalResult } from '../sidepanel/sandbox-host';

const OFFSCREEN_URL = 'offscreen.html';
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // hasDocument() is the cheap check; guard concurrent creates with `creating`
  // (and swallow the "single offscreen document" race if two callers slip past).
  if (await chrome.offscreen.hasDocument()) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
      justification: 'Evaluate adapter source in a sandboxed iframe without the side panel.',
    })
    .then(() => undefined)
    .catch((e) => {
      if (!String(e).toLowerCase().includes('single offscreen')) throw e;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

/** Eval adapter source via the offscreen document. Never throws — adapter-level
 * problems come back as `{ ok:false, error }`. */
export async function evalAdapterViaOffscreen(source: string): Promise<SandboxEvalResult> {
  try {
    await ensureOffscreen();
    const r = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_EVAL_ADAPTER',
      src: source,
    })) as SandboxEvalResult | undefined;
    return r ?? { ok: false, defs: [], error: 'offscreen returned no result' };
  } catch (e) {
    return { ok: false, defs: [], error: e instanceof Error ? e.message : String(e) };
  }
}
