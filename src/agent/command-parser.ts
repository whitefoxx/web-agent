/**
 * Extract agent commands from a chatbot reply and separate them from the
 * surrounding prose.
 *
 * Canonical format (recommended in the system prompt):
 *
 *   <agent-command>
 *   {"action":"execute_tool", "tool":"xiaohongshu__feed", "args":{"limit":10}}
 *   </agent-command>
 *
 * We deliberately avoid ```code fences``` for the primary path because every
 * chatbot UI applies its own special rendering to fenced blocks (language
 * banner, Copy/Download buttons, syntax highlighting, line numbers, …)
 * which both clutters the visible chat and complicates DOM-to-markdown
 * extraction. Plain custom HTML tags are typically passed through as-is by
 * markdown renderers (or stripped, in which case the inner JSON survives
 * as prose and we can still recover it from a JSON-shape heuristic).
 *
 * Backward-compat fallbacks (also recognised so we don't break if the LLM
 * defaults to a fenced block anyway):
 *   - ```agent-command\n{...}\n``` (any case, also `agent_command` / `agentcommand`)
 *   - ```json\n{...}\n``` or empty-lang fences, when the body is a JSON
 *     object whose root has an `action` field
 *
 * Parse failures inside a recognised wrapper become a synthetic
 * `parse_error` command so the orchestrator can surface the issue rather
 * than silently dropping it.
 */

import type { ParsedCommand } from '../connectors/messages';

/** Primary path: <agent-command>...</agent-command>. Tag name allows `-`,
 *  `_`, optional whitespace, and any attributes (defensively ignored). */
const TAG_RE = /<agent[-_]?command\b[^>]*>([\s\S]*?)<\/agent[-_]?command\s*>/gi;

/** Fallback: markdown fenced blocks. */
const FENCE_RE = /```([^\n`]*)\r?\n([\s\S]*?)\r?\n```/g;

const AGENT_LANG_RE = /^\s*agent[-_]?command\s*$/i;
const PERMISSIVE_LANGS = new Set(['', 'json', 'jsonc']);

export interface ParseResult {
  /** Same as the input, with each recognised command construct removed (and
   * replaced by a single newline so paragraph breaks remain natural).
   * Non-command code blocks are preserved verbatim. */
  cleanedText: string;
  commands: ParsedCommand[];
}

interface Hit {
  start: number;
  end: number;
  body: string;
  raw: string;
}

export function parseAgentCommands(rawText: string): ParseResult {
  const hits: Hit[] = [];

  // Primary scan: <agent-command>JSON</agent-command>
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(rawText)) !== null) {
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      body: m[1].trim(),
      raw: m[0],
    });
  }

  // Fallback scan: ```fence``` blocks. Skip any that overlap a hit we
  // already captured (the LLM might wrap a fenced block inside the tag).
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(rawText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (hits.some((h) => start < h.end && end > h.start)) continue;
    const lang = m[1] ?? '';
    const body = m[2].trim();
    if (classifyFence(lang, body) === 'skip') continue;
    hits.push({ start, end, body, raw: m[0] });
  }

  hits.sort((a, b) => a.start - b.start);

  const commands: ParsedCommand[] = [];
  let cleanedText = '';
  let cursor = 0;
  for (const h of hits) {
    cleanedText += rawText.slice(cursor, h.start);
    commands.push(parseOne(h.body, h.raw));
    cleanedText += '\n';
    cursor = h.end;
  }
  cleanedText += rawText.slice(cursor);
  cleanedText = collapseExtraBlankLines(cleanedText).trim();

  return { cleanedText, commands };
}

function classifyFence(lang: string, body: string): 'accept' | 'skip' {
  if (AGENT_LANG_RE.test(lang)) return 'accept';
  const langKey = lang.trim().toLowerCase();
  if (!PERMISSIVE_LANGS.has(langKey)) return 'skip';
  // Cheap pre-check before paying for JSON.parse — fence body must start
  // with `{` and contain an "action" key textually.
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{')) return 'skip';
  if (!/"action"\s*:/.test(body)) return 'skip';
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.action === 'string') {
      return 'accept';
    }
  } catch {
    // not valid JSON — leave the block alone so it renders as a regular
    // code sample in the SidePanel
  }
  return 'skip';
}

function parseOne(jsonText: string, raw: string): ParsedCommand {
  try {
    const obj = JSON.parse(jsonText);
    if (!obj || typeof obj !== 'object') {
      return { action: 'parse_error', message: 'JSON did not decode to an object', raw };
    }
    return {
      action: typeof obj.action === 'string' ? obj.action : 'parse_error',
      tool: typeof obj.tool === 'string' ? obj.tool : undefined,
      args:
        obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
          ? (obj.args as Record<string, unknown>)
          : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
      raw,
    };
  } catch (e) {
    return {
      action: 'parse_error',
      message: e instanceof Error ? e.message : String(e),
      raw,
    };
  }
}

function collapseExtraBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}
