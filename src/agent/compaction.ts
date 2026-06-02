/**
 * Context compaction — when a long loop's prompt grows toward the model's
 * window, summarize the OLDER half of the running message array into one
 * structured "progress ledger" and keep only that + the most recent messages.
 * This is what lets a 40-step loop run without blowing context (缺口 #3); it
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
      lines.push(`【用户】${typeof m.content === 'string' ? m.content : '[多模态消息]'}`);
    } else if (m.role === 'assistant') {
      const calls = m.tool_calls?.length
        ? ` (调用工具: ${m.tool_calls.map((c) => c.function.name).join(', ')})`
        : '';
      if (m.content) lines.push(`【助手】${m.content}${calls}`);
      else if (calls) lines.push(`【助手】${calls.trim()}`);
    } else if (m.role === 'tool') {
      const c =
        m.content.length > perToolCap ? m.content.slice(0, perToolCap) + '…[截断]' : m.content;
      lines.push(`【工具结果】${c}`);
    } else if (m.role === 'system') {
      lines.push(`【系统】${m.content}`);
    }
  }
  return lines.join('\n');
}

export const COMPACTION_SYSTEM =
  '你是一个对话压缩器。把给定的浏览器 agent 执行历史压缩成一段结构化「进度摘要」,供后续继续任务时作为上下文。无损保留关键事实(尤其是抓到的数据、URL、ID),丢弃冗余过程描述。';

/** Build the sub-call messages that ask the model to summarize `older` into the
 * structured ledger. No tools — it's a plain text→text summarization. */
export function buildCompactionMessages(older: ApiMessage[]): ApiMessage[] {
  return [
    { role: 'system', content: COMPACTION_SYSTEM },
    {
      role: 'user',
      content:
        '请把下面的执行历史压缩成结构化进度摘要,严格分为以下段落(没有内容的段写「无」):\n' +
        '1. 用户意图\n' +
        '2. 已完成步骤与关键结果\n' +
        '3. 抓到的关键数据(标题/作者/URL/ID 等,后续可能要引用)\n' +
        '4. 当前页面/标签页状态\n' +
        '5. 下一步计划\n' +
        '6. 出现过的错误 / 限流\n' +
        '7. 待用户确认项\n' +
        '只输出摘要本身,不要寒暄,不要用代码块包裹。\n\n===== 历史 =====\n' +
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
    content: `[此前进度摘要(已压缩 ${idx} 条较早的历史消息,要点如下)]\n${summary}`,
  });
  return idx - 1;
}
