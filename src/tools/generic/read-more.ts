import { cli } from '@base/runtime/registry.js';
import { readChunk } from '../../runtime/oversize-cache';

/**
 * Continuation reads for oversize tool results (docs/agent-harness.md
 * §truncation): when a result is cut at MAX_TOOL_RESULT_CHARS the marker names
 * a stash id + offset; this tool pages through the rest — the divide-and-
 * conquer path to COMPLETE data instead of silently losing the tail.
 */

const DEFAULT_CHUNK = 30_000;
const MAX_CHUNK = 60_000;

cli({
  site: 'generic',
  name: 'read_more',
  access: 'read',
  description:
    'Continue reading an oversized tool result that was truncated. When a tool result ends with a `…[Truncated N chars … read_more {"id":"…","offset":…}]` marker, use the id and offset from the marker to call this tool and read the remaining content in chunks (default 30k chars per chunk; it returns next_offset to continue, until done:true). **When you need the full data, be sure to read it all before concluding**; if the volume is large, read it in chunks and distill chunk by chunk (divide and conquer). The cache is kept for about 15 minutes; after it expires you must re-run the original tool',
  args: [
    {
      name: 'id',
      type: 'string',
      required: true,
      help: 'The cache id given in the truncation marker (like ov_xxxx)',
    },
    {
      name: 'offset',
      type: 'int',
      help: 'Which character to start reading from. Use the offset from the truncation marker the first time; then use the next_offset returned last time. Default 0',
    },
    {
      name: 'max_chars',
      type: 'int',
      help: `Max characters to read in this chunk (default ${DEFAULT_CHUNK}, cap ${MAX_CHUNK})`,
    },
  ],
  func: async (_page: unknown, kwargs: Record<string, unknown>) => {
    const id = String(kwargs.id ?? '');
    if (!id) throw new Error('id is required (from the truncation marker)');
    const offset = Math.max(0, Number(kwargs.offset ?? 0) || 0);
    const maxChars = Math.max(
      1_000,
      Math.min(MAX_CHUNK, Number(kwargs.max_chars ?? DEFAULT_CHUNK) || DEFAULT_CHUNK),
    );
    const r = readChunk(id, offset, maxChars);
    if (!r.ok) throw new Error(r.error ?? 'read_more failed');
    return r;
  },
});
