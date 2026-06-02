/**
 * Tool subsetting — when the adapter registry exposes a lot of tools, narrow the
 * set sent to the model by relevance to the task, so the prompt doesn't bloat
 * and tool selection stays sharp. Conservative by design: only narrows above a
 * threshold, only drops sites the task does NOT name, and falls back to the full
 * set when the task names no recognizable site (never strands the model).
 * Pure — see tests/tool-select.test.ts. docs/agent-harness.md §10.12.
 */

export interface ToolSelectConfig {
  /** Only subset when there are MORE than this many tools. */
  threshold: number;
}

export const DEFAULT_TOOL_SELECT: ToolSelectConfig = { threshold: 40 };

interface ToolLike {
  function: { name: string; description?: string };
}

export interface ToolSelection<T> {
  tools: T[];
  narrowed: boolean;
  dropped: number;
}

function siteOf(name: string): string {
  const i = name.indexOf('__');
  return i >= 0 ? name.slice(0, i) : '';
}

/**
 * Keep generic (site-agnostic) tools always; keep a site's tools when the task
 * text names that site. If the task names no recognizable site, or there are
 * few tools, return everything unchanged.
 */
export function selectTools<T extends ToolLike>(
  tools: T[],
  userText: string,
  cfg: ToolSelectConfig = DEFAULT_TOOL_SELECT,
): ToolSelection<T> {
  if (tools.length <= cfg.threshold) return { tools, narrowed: false, dropped: 0 };
  const text = userText.toLowerCase();
  const matchedSites = new Set<string>();
  for (const t of tools) {
    const s = siteOf(t.function.name);
    if (s && s !== 'generic' && text.includes(s.toLowerCase())) matchedSites.add(s);
  }
  // Task named no recognizable site → keep everything (don't risk stranding the
  // model by dropping the tool it actually needs).
  if (matchedSites.size === 0) return { tools, narrowed: false, dropped: 0 };
  const kept = tools.filter((t) => {
    const s = siteOf(t.function.name);
    return !s || s === 'generic' || matchedSites.has(s);
  });
  return {
    tools: kept,
    narrowed: kept.length < tools.length,
    dropped: tools.length - kept.length,
  };
}
