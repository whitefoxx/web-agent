/**
 * OpenAI-compatible chat types, shared between the API engine and the session
 * store (which persists the running message array for follow-up turns).
 *
 * Kept dependency-free so both `session.ts` and `api-engine.ts` can import it
 * without creating an import cycle.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ApiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      /** Some providers' thinking mode requires echoing this back. */
      reasoning_content?: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };
