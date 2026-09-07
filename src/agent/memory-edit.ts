/**
 * Scoped "add or update memory" LLM call — powers the memory page's bottom
 * "Add or update" box (ChatGPT-style). Given the current memory document and a
 * short natural-language instruction, the model returns the FULL updated
 * document (integrating the new info, keeping still-valid old info, deduped and
 * trimmed). This is a single self-contained completion on the primary model —
 * NOT a browser-agent session (no tools, no page access).
 */
import { chatCompletion } from './chat-completion';
import { resolveSlots, needsBaseUrl } from '../config/llm-config';
import { log, warn } from '@base/runtime/log';

const SYSTEM = `You are helping the user maintain a [long-term memory] — a markdown document about the user themselves (facts, preferences, background, what they are working on, etc.) that is provided to the assistant at the start of every conversation for reference.

The user will give you an [add or update] instruction. Output the [full updated memory document], with these requirements:
- Incorporate the new information the user gave this time;
- Keep existing content that is still valid; only rewrite or delete it when it conflicts with the new information or is outdated;
- Deduplicate, merge similar items, and keep it concise and well-organized (you may use small headings + short sentences / short lists);
- Write in the language the user uses;
- Output only the markdown of the memory document itself — no preamble, explanation, or code fences.`;

export interface MemoryEditResult {
  content?: string;
  error?: string;
}

/** Rewrite the memory blob per `instruction`. Returns the new content or an
 * error string (missing model config / empty result / call failure). */
export async function editMemoryWithLLM(
  current: string,
  instruction: string,
  signal?: AbortSignal,
): Promise<MemoryEditResult> {
  const instr = instruction.trim();
  if (!instr) return { error: 'Please enter the content to add or update first.' };

  const { primary } = await resolveSlots();
  if (!primary?.apiKey) return { error: 'No primary model API Key configured (Settings → Model roles).' };
  if (needsBaseUrl(primary.provider) && !primary.baseUrl)
    return { error: 'Primary model has no Base URL configured.' };

  const userMsg =
    `[Current memory document]\n${current.trim() || '(empty)'}\n\n` +
    `[User's add/update instruction]\n${instr}\n\nOutput the full updated memory document.`;

  try {
    const resp = await chatCompletion({
      apiKey: primary.apiKey,
      baseUrl: primary.baseUrl,
      provider: primary.provider,
      signal,
      body: {
        model: primary.model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
        max_tokens: 2000,
      },
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    if (!out) return { error: 'The model returned no content; please try again.' };
    log('memory', 'edit ok', { inLen: current.length, outLen: out.length });
    // Strip an accidental ```md fence if the model added one anyway.
    const unfenced = out
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();
    return { content: unfenced };
  } catch (e) {
    warn('memory', 'edit failed', e);
    return { error: `Update failed: ${(e as Error)?.message ?? e}` };
  }
}
