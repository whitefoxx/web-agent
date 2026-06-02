/**
 * SSE streaming for chat-completions — pure parsing + delta accumulation so a
 * long generation streams into the UI (live char count) instead of black-
 * screening. Kept dependency-free and side-effect-free so it unit-tests by
 * feeding chunk strings; the actual fetch-body reading lives in api-engine.
 * docs/agent-harness.md §10.8.
 */

export interface StreamToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface StreamAccumulated {
  content: string;
  reasoning_content: string;
  tool_calls: StreamToolCall[];
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Accumulates OpenAI streaming deltas (content / reasoning_content /
 * tool_calls-by-index / usage / finish_reason) into a final message shape. */
export function createStreamAccumulator() {
  const acc: StreamAccumulated = {
    content: '',
    reasoning_content: '',
    tool_calls: [],
    finish_reason: null,
  };
  return {
    /** Feed one parsed SSE `data:` JSON object. */
    push(chunk: unknown): void {
      const c = chunk as {
        choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
        usage?: StreamAccumulated['usage'];
      };
      if (c?.usage) acc.usage = c.usage;
      const choice = c?.choices?.[0];
      if (!choice) return;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string') acc.content += d.content;
      if (typeof d.reasoning_content === 'string') acc.reasoning_content += d.reasoning_content;
      const deltaCalls = d.tool_calls as
        | Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;
      if (Array.isArray(deltaCalls)) {
        for (const tc of deltaCalls) {
          const idx = typeof tc.index === 'number' ? tc.index : acc.tool_calls.length;
          let slot = acc.tool_calls[idx];
          if (!slot) {
            slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
            acc.tool_calls[idx] = slot;
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string')
            slot.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) acc.finish_reason = choice.finish_reason;
    },
    result(): StreamAccumulated {
      return { ...acc, tool_calls: acc.tool_calls.filter(Boolean) };
    },
  };
}

/**
 * Split a growing SSE buffer into complete `data:` JSON events, returning the
 * parsed objects plus the leftover (incomplete) tail to carry into the next
 * read. Tolerates `\r\n`, blank lines, comments, and `[DONE]`.
 */
export function parseSSEChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
    buffer = buffer.slice(nl + 1);
    if (!line || !line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* partial / non-JSON keep-alive line — ignore */
    }
  }
  return { events, rest: buffer };
}
