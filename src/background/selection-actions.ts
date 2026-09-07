/**
 * Selection toolbar SW-side actions.
 *
 * SELECTION_LLM — one bounded /chat/completions round-trip over the selected
 * text (translate/explain/summarize/custom). Deliberately NOT the agent loop: no
 * tools, no session, no history — the whole point of the toolbar is sub-second-
 * to-a-few-seconds quick answers rendered in the in-page popover.
 *
 * SELECTION_ASK — "Ask": open the SidePanel while the user-gesture context is
 * still alive (must be called synchronously from the message handler), and park
 * the quote in chrome.storage.session for the panel to consume into the
 * composer (the panel may not even be listening yet — session storage bridges
 * the open race; panel reads on mount AND watches onChanged).
 */

import { chatCompletion } from '../agent/chat-completion';
import { resolveSlots, needsBaseUrl } from '../config/llm-config';
import { composeSelectionPrompt, SELECTION_SYSTEM_PROMPT } from '@base/selection/prompt';
import { log, warn } from '@base/runtime/log';
import { msgOf } from '@base/background/runtime-state';
import type { SelectionLlmReq, SelectionAskReq } from '../messages';

const SCOPE = 'sw';

const LLM_TIMEOUT_MS = 60_000;

export async function handleSelectionLlm(
  m: SelectionLlmReq,
): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const { primary } = await resolveSlots();
    if (!primary?.apiKey || (needsBaseUrl(primary.provider) && !primary.baseUrl)) {
      return { ok: false, error: 'Primary model API Key not configured (side panel → menu → LLM config)' };
    }
    // Shared with localmd Connect, whose bar asks the same question of the
    // app's model instead of this shell's (selection/prompt.ts).
    const system = SELECTION_SYSTEM_PROMPT;
    const user = composeSelectionPrompt(m);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    try {
      const resp = await chatCompletion({
        apiKey: primary.apiKey,
        baseUrl: primary.baseUrl,
        provider: primary.provider,
        body: {
          model: primary.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          max_tokens: 1200,
        },
        signal: ctl.signal,
      });
      const text = resp.choices?.[0]?.message?.content?.trim();
      log(SCOPE, `selection ${m.label} done`, { in: m.text.length, out: text?.length ?? 0 });
      return text ? { ok: true, result: text } : { ok: false, error: 'The model returned no content' };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    warn(SCOPE, 'selection llm failed', e);
    return { ok: false, error: msgOf(e) };
  }
}

export function handleSelectionAsk(
  m: SelectionAskReq,
  sender: chrome.runtime.MessageSender,
): void {
  // Synchronous — sidePanel.open() must run inside the user-gesture window.
  try {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') void chrome.sidePanel.open({ tabId });
    else if (typeof sender.tab?.windowId === 'number') {
      void chrome.sidePanel.open({ windowId: sender.tab.windowId });
    }
  } catch (e) {
    warn(SCOPE, 'sidePanel.open failed (gesture expired?)', e);
  }
  void chrome.storage.session
    .set({
      pendingSelectionAsk: {
        text: m.text,
        title: m.title ?? '',
        url: m.url ?? '',
        ts: Date.now(),
      },
    })
    .catch(() => {});
}
