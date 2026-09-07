/**
 * Message-array hygiene for the API engine: truncate/serialize tool results, and
 * sanitizeHistory — repair a persisted OpenAI message history before re-sending
 * it (pad dangling tool_calls so the API doesn't 400, flatten prior-turn images
 * to text so they aren't re-sent every turn). Split out of api-engine.ts.
 */

import type { ApiMessage, ContentPart } from './api-types';
import { stashOversize } from '../runtime/oversize-cache';

export const MAX_TOOL_RESULT_CHARS = 64_000;

export function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n…[truncated ${s.length - max} chars]`;
}

/** Truncate an oversize tool result AND stash the full text so the model can
 * page through the rest via `read_more` (divide-and-conquer) instead of losing
 * it. Returns how many chars were cut so the engine can tell the USER a
 * truncation happened (they could never see it before). */
export function truncateStash(
  s: string,
  max = MAX_TOOL_RESULT_CHARS,
): { text: string; truncated: number } {
  if (s.length <= max) return { text: s, truncated: 0 };
  const id = stashOversize(s);
  return {
    text:
      s.slice(0, max) +
      `\n\n…[Truncated ${s.length - max} chars (of ${s.length} total). The full result is stashed for ~15 minutes — when you need the rest, call read_more {"id":"${id}","offset":${max}} to page through it, read all the key information before concluding; if your final answer depends on the truncated data, tell the user that truncation occurred]`,
    truncated: s.length - max,
  };
}

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Parse an OpenAI tool_call `arguments` string into an args object, repairing the
 * malformed-but-recoverable output weaker / cheaper models emit. Well-formed JSON
 * takes the happy path (identical to a bare `JSON.parse`); the repair steps fire
 * ONLY when a plain parse fails — exactly the cases where the previous code fell
 * back to `{}` and silently ran the tool with no args. So this only RECOVERS
 * calls, never alters a well-formed one. Always returns a plain object (never
 * throws); non-object JSON (a stray array / number / bare string) collapses to
 * `{}` like an unusable arg set.
 *
 * Repairs, in order: strip a ```json … ``` code fence; unwrap a double-stringified
 * value (a JSON string that itself contains the JSON); extract the first `{…}`
 * block from surrounding prose.
 */
export function parseToolArgs(raw: string | null | undefined): Record<string, unknown> {
  const s = (raw ?? '').trim();
  if (!s) return {};

  const direct = asArgsObject(s);
  if (direct) return direct;

  // ```json … ``` (or bare ```) fence
  const unfenced = s
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  if (unfenced !== s) {
    const r = asArgsObject(unfenced);
    if (r) return r;
  }

  // double-stringified: the whole value is a JSON string holding the real JSON
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner = JSON.parse(s);
      if (typeof inner === 'string') {
        const r = asArgsObject(inner);
        if (r) return r;
      }
    } catch {
      /* fall through */
    }
  }

  // first {…} block embedded in prose / wrapped by trailing junk
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) {
    const r = asArgsObject(m[0]);
    if (r) return r;
  }

  return {};
}

/** JSON.parse `s` and return it only if it's a plain (non-array) object, else null. */
function asArgsObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Flatten a multimodal user `content` array down to plain text, for replaying
 * a vision turn's history to a text-only model (which 400s on image content). */
function contentPartsToText(parts: ContentPart[]): string {
  const texts: string[] = [];
  let imgs = 0;
  for (const p of parts) {
    if (p.type === 'text') texts.push(p.text);
    else if (p.type === 'image_url') imgs++;
  }
  let s = texts.join('\n');
  if (imgs) s += `${s ? '\n' : ''}[${imgs} image(s) shown in the previous turn; omitted here to save context]`;
  return s || '[image]';
}

/**
 * Repair a persisted message history before re-sending it:
 *   1. Every assistant message with `tool_calls` must be answered by a tool
 *      message for each id BEFORE any non-tool message — else the API 400s.
 *      An abort mid tool-loop (e.g. during a write-confirm) can leave dangling
 *      ids; pad them with placeholder tool messages.
 *   2. Flatten any PRIOR-turn image-bearing user message (ContentPart[]) down to
 *      text. The model already saw those images live in the turn they were
 *      produced (the active messages array that turn), and its response — kept
 *      in history — carries what it gleaned. Re-sending base64 every subsequent
 *      turn is pure token/bandwidth cost, and replaying images to a since-
 *      switched text-only model would 400. So images live for exactly one turn.
 */
export function sanitizeHistory(history: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === 'user' && Array.isArray(m.content)) {
      out.push({ role: 'user', content: contentPartsToText(m.content) });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push(m);
      const answered = new Set<string>();
      let j = i + 1;
      while (j < history.length && history[j]!.role === 'tool') {
        const tm = history[j] as { role: 'tool'; tool_call_id: string; content: string };
        out.push(tm);
        answered.add(tm.tool_call_id);
        j++;
      }
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          // The call was interrupted before a result was persisted (SW recycled
          // or the request timed out). The OLD text "[interrupted, no result]" read
          // like the tool ran and returned nothing → the model wrongly concluded the
          // tool didn't exist and gave up (F-34, ProductHunt synthesize_adapter). Be
          // explicit: it's an interruption, the tool is still available, retry if
          // needed (verify first for writes). Name the tool so intent is clear.
          out.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `[The previous call to ${tc.function.name || 'this tool'} was interrupted and did not finish (the extension's background was recycled or the request timed out) — this does NOT mean the tool is unavailable. If this step is still needed, call it again; for write operations, first verify whether the previous call already took effect.]`,
          });
        }
      }
      i = j - 1;
      continue;
    }
    out.push(m);
  }
  return out;
}
