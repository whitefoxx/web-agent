import { cli } from '@base/runtime/registry.js';
import { listAllHighlights } from '@base/selection/highlights-store';
import { FEATURES } from '../../config/features';

/**
 * Read the user's persistent selection-toolbar highlights, grouped by page —
 * the agent-side of "categorize and summarize all my highlights" / "which pages
 * did I highlight on". Read-only; management (delete/clear) stays in the panel UI.
 *
 * Gated off in the product build (FEATURES.selectionToolbar) — the toolbar that
 * creates highlights is hidden there, so this tool would only ever read empty.
 */
if (FEATURES.selectionToolbar) {
  cli({
    site: 'generic',
    name: 'get_highlights',
    access: 'read',
    description:
      'Read the persistent highlights the user made on web pages via the selection toolbar, grouped by page (url / page title / each highlight text + date). Use for "summarize/categorize all my highlights", "which pages did I highlight on", "organize the highlights on some topic into a note", etc. Optional query filter (matches URL/title/highlight content).',
    args: [
      {
        name: 'query',
        type: 'string',
        help: 'Optional: keyword filter (URL / page title / highlight text, case-insensitive)',
      },
      {
        name: 'limit',
        type: 'int',
        help: 'Max highlights to return (default 200, cap 1000)',
      },
    ],
    func: async (_page: unknown, kwargs: Record<string, unknown>) => {
      const q = typeof kwargs.query === 'string' ? kwargs.query.trim().toLowerCase() : '';
      const cap = Math.max(1, Math.min(1000, Number(kwargs.limit ?? 200)));
      const pages = await listAllHighlights();
      let total = 0;
      const results: {
        url: string;
        title: string;
        count: number;
        highlights: { text: string; date: string }[];
      }[] = [];
      for (const p of pages) {
        const title = p.entries.find((e) => e.title)?.title ?? '';
        const rows = p.entries
          .filter(
            (e) =>
              !q ||
              e.exact.toLowerCase().includes(q) ||
              title.toLowerCase().includes(q) ||
              p.url.toLowerCase().includes(q),
          )
          .sort((a, b) => b.ts - a.ts)
          .map((e) => ({ text: e.exact, date: new Date(e.ts).toISOString().slice(0, 10) }));
        if (!rows.length) continue;
        const take = rows.slice(0, Math.max(0, cap - total));
        if (!take.length) break;
        total += take.length;
        results.push({ url: p.url, title, count: rows.length, highlights: take });
        if (total >= cap) break;
      }
      return {
        pages: results.length,
        total,
        results,
        ...(total >= cap ? { truncated: true, note: `Truncated at limit=${cap}` } : {}),
      };
    },
  });
}
