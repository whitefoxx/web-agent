/**
 * Context compaction — when a long loop's prompt grows toward the model's
 * window, summarize the OLDER half of the running message array into one
 * structured "progress ledger" and keep only that + the most recent messages.
 * This is what lets a 40-step loop run without blowing context (gap #3); it
 * mirrors Claude Code's auto-compact (the very thing that bootstraps a
 * continued session).
 *
 * The pure parts live here (boundary finding, transcript rendering, applying a
 * summary) so they unit-test deterministically — see tests/compaction.test.ts.
 * The LLM sub-call that actually produces the summary is orchestrated in
 * api-engine (it owns the provider config). docs/agent-harness.md §10.3.
 */

import type { ApiMessage } from './api-types';

/** How many trailing messages to keep verbatim (the rest is compactable). */
export const KEEP_RECENT_MESSAGES = 8;

/**
 * Find a clean cut index: `messages[0..idx)` is "older" (compactable) and
 * `messages[idx..]` is "recent" (kept verbatim). The cut NEVER lands on a
 * `tool` message — that would orphan it from the assistant `tool_calls` it
 * answers and 400 the next request. Walking forward off any tool message also
 * guarantees the older slice has every assistant's tool answers with it (no
 * dangling tool_calls). Returns 0 when there's nothing safely compactable.
 */
export function findCompactionBoundary(
  messages: ApiMessage[],
  minKeep = KEEP_RECENT_MESSAGES,
): number {
  if (messages.length <= minKeep) return 0;
  let idx = messages.length - minKeep;
  while (idx < messages.length && messages[idx]!.role === 'tool') idx++;
  if (idx >= messages.length) return 0;
  return idx;
}

/** Render the older slice as a compact plain-text transcript for the
 * summarizer. Tool results are truncated — the summary captures their gist, not
 * their raw bytes. Multimodal user messages collapse to a marker (their images
 * only ever lived one turn anyway). */
export function renderHistoryForSummary(older: ApiMessage[], perToolCap = 1500): string {
  const lines: string[] = [];
  for (const m of older) {
    if (m.role === 'user') {
      lines.push(`[User] ${typeof m.content === 'string' ? m.content : '[multimodal message]'}`);
    } else if (m.role === 'assistant') {
      const calls = m.tool_calls?.length
        ? ` (called tools: ${m.tool_calls.map((c) => c.function.name).join(', ')})`
        : '';
      if (m.content) lines.push(`[Assistant] ${m.content}${calls}`);
      else if (calls) lines.push(`[Assistant] ${calls.trim()}`);
    } else if (m.role === 'tool') {
      const c =
        m.content.length > perToolCap ? m.content.slice(0, perToolCap) + '…[truncated]' : m.content;
      lines.push(`[Tool result] ${c}`);
    } else if (m.role === 'system') {
      lines.push(`[System] ${m.content}`);
    }
  }
  return lines.join('\n');
}

export const COMPACTION_SYSTEM =
  'You are a conversation compactor. Compress the given browser-agent execution history into a structured "progress summary" to serve as context when the task later resumes. Preserve key facts losslessly (especially captured data, URLs, IDs), and drop redundant process narration.';

/** Build the sub-call messages that ask the model to summarize `older` into the
 * structured ledger. No tools — it's a plain text→text summarization. */
export function buildCompactionMessages(older: ApiMessage[]): ApiMessage[] {
  return [
    { role: 'system', content: COMPACTION_SYSTEM },
    {
      role: 'user',
      content:
        'Compress the execution history below into a structured progress summary, strictly divided into the following sections (write "None" for any section with no content):\n' +
        '1. User intent\n' +
        '2. Completed steps and key results\n' +
        '3. Key data captured (title / author / URL / ID etc. — may be cited later)\n' +
        '4. Current page / tab state\n' +
        '5. Next-step plan\n' +
        '6. Errors / rate limits encountered\n' +
        '7. Items awaiting user confirmation\n' +
        'Output only the summary itself — no pleasantries, no code fences.\n\n===== History =====\n' +
        renderHistoryForSummary(older),
    },
  ];
}

/** Replace `messages[0..idx)` with a single summary user-message, IN PLACE (so
 * the caller's array reference — shared with the persisted session — stays
 * valid). Returns the net number of messages removed, or 0 if the boundary is
 * too small to be worth compacting. */
export function applyCompaction(messages: ApiMessage[], summary: string, idx: number): number {
  if (idx < 2 || idx > messages.length) return 0;
  messages.splice(0, idx, {
    role: 'user',
    content: `[Prior progress summary (compacted ${idx} earlier history messages; key points below)]\n${summary}`,
  });
  return idx - 1;
}
