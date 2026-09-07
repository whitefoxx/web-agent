/**
 * Unified "command" model — workflows (prompt recipes) / adapters / built-ins
 * referenced from the composer like Claude Code / Monica slash-commands.
 *
 * - workflows (stored as prompt shortcuts) expand to their recipe text (no marker —
 *   they're just prompts; the text may itself embed ⟦tool:..⟧).
 * - adapters/tools & built-in commands insert as ATOMIC chips, serialized on send
 *   to a marked token: ⟦tool:NAME⟧ / ⟦cmd:NAME⟧. The markers let the agent tell a
 *   deliberate command reference from look-alike plain text. ⟦cmd:..⟧ chips are
 *   pure UI sugar for a canned instruction: on send they are replaced by the
 *   built-in's prompt text (expandCommandTokens); tool tokens stay as markers.
 *   For display (chat bubbles, previews) all tokens collapse to /NAME via
 *   tokensToDisplay.
 *
 * The token brackets ⟦ ⟧ (U+27E6/27E7) are effectively absent from normal input,
 * so parsing is unambiguous.
 */

import type { Shortcut, ShortcutMode } from '../shortcuts/store';
import type { Skill } from '../skills/store';
import type { AdapterCommand } from '../messages';
import type { MarketAdapter } from '@base/core/marketplace';

/** Merge the registry tool catalog (generic tools + loaded/synthesized adapters,
 * WITH arg schemas) and the full marketplace catalog (metadata only) into the
 * `/` palette's insertable-tools list. Registry entries win on dedupe — they
 * carry arg schemas and reflect what's actually loaded. Marketplace adapters are
 * included so the user can reference ANY adapter with `/` even before it's
 * loaded; the runtime loads a referenced-but-unloaded adapter on send/run. */
export function mergeToolCatalog(
  registry: AdapterCommand[],
  market: MarketAdapter[],
): AdapterCommand[] {
  const seen = new Set(registry.map((c) => c.tool));
  const fromMarket: AdapterCommand[] = [];
  for (const a of market) {
    const tool = `${a.site}__${a.name}`;
    if (seen.has(tool)) continue;
    seen.add(tool);
    fromMarket.push({
      tool,
      site: a.site,
      name: a.name,
      description: a.description,
      access: a.access,
      kind: a.type,
    });
  }
  return [...registry, ...fromMarket];
}

/** Chip kinds that serialize to a token (workflows expand to text, no chip). */
export type ChipKind = 'tool' | 'cmd';

/** A built-in `/` command: either switches the composer mode, or drops a ⟦cmd:..⟧
 * chip that carries a canned instruction (e.g. asking the agent to search the
 * marketplace). The two are mutually exclusive — `mode` ⇒ mode switch (no chip),
 * `insertText` ⇒ a `cmd` chip that expands to this text on send. */
export interface BuiltinCommand {
  id: string;
  label: string;
  desc: string;
  /** Switch the composer to this mode (no chip inserted). */
  mode?: ShortcutMode;
  /** Or insert a `cmd` chip whose token expands to this prompt text on send. */
  insertText?: string;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { id: 'plan', label: 'plan · plan first, then run', desc: 'Switch to plan-first mode', mode: 'plan' },
  {
    id: 'explore',
    label: 'explore · explore and generate a tool',
    desc: 'Switch to explore-and-generate-a-tool mode',
    mode: 'explore',
  },
  {
    id: 'find-adapters',
    label: 'find-adapters · find an adapter',
    desc: 'Have the AI find a ready-made adapter for your task in the marketplace',
    insertText:
      'Use find_adapters to find adapters in the marketplace that fit the task below, and briefly explain what each one does, whether it needs login, and whether you recommend installing it:\n',
  },
  {
    id: 'create-workflow',
    label: 'create-workflow · new workflow',
    desc: 'Have the AI turn this process into a reusable workflow (prompt recipe)',
    insertText:
      'Turn the process described below into a reusable workflow (save it with create_workflow): spell out the steps, which tools/adapters to call, the inputs and outputs, and how to organize the results:\n',
  },
  {
    id: 'create-skill',
    label: 'create-skill · new skill',
    desc: 'Have the AI turn "how to handle a class of task" into a reusable skill (auto-loaded on demand later)',
    insertText:
      'Turn the approach described below into a reusable [skill] (save it with create_skill; give a name, a one-line description, and a markdown body — in the body, use ⟦tool:tool-id⟧ to indicate which tools/adapters/workflows to call):\n',
  },
];

/** A pickable command in the `/` palette. Workflows are stored as prompt shortcuts,
 * so their picker kind is still 'shortcut' (labelled workflow in the UI). Skills are
 * kind 'skill' — picking one inserts its markdown body (like a workflow). */
export interface CommandItem {
  kind: 'shortcut' | 'tool' | 'builtin' | 'skill';
  /** Stable id for keys. */
  id: string;
  /** Canonical name used in the token / lookup (tool id, workflow/skill label). */
  name: string;
  /** Display label. */
  label: string;
  /** Secondary line in the picker. */
  desc?: string;
  /** Present for kind==='shortcut'. */
  shortcut?: Shortcut;
  /** Present for kind==='builtin'. */
  builtin?: BuiltinCommand;
  /** Present for kind==='skill'. */
  skill?: Skill;
}

export function toolToken(name: string): string {
  return `⟦tool:${name}⟧`;
}
export function cmdToken(name: string): string {
  return `⟦cmd:${name}⟧`;
}

export interface ParsedToken {
  kind: ChipKind;
  name: string;
}

const TOKEN_RE = /⟦(tool|cmd):([^⟧]+)⟧/g;

/** Extract every command token from a serialized composer string. */
export function parseTokens(text: string): ParsedToken[] {
  const out: ParsedToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ kind: m[1] as ChipKind, name: m[2] });
  return out;
}

/** Replace ⟦cmd:NAME⟧ chips with the built-in's canned prompt text, so the agent
 * receives the full instruction (the chip is just composer UI). wf/tool tokens
 * are left untouched — they stay as markers and get their context injected
 * separately. Unknown ids drop to ''. */
export function expandCommandTokens(text: string): string {
  return text.replace(/⟦cmd:([^⟧]+)⟧/g, (_m, id: string) => {
    const b = BUILTIN_COMMANDS.find((x) => x.id === id);
    return b?.insertText ?? '';
  });
}

/** Human-readable rendering of a serialized composer string: every command token
 * collapses to /NAME. Used for chat bubbles and shortcut previews. */
export function tokensToDisplay(text: string): string {
  return text.replace(TOKEN_RE, '/$2');
}

/** Build the command categories for the picker. `opts.builtins` adds the
 * built-in command group (only wanted in the main composer, not the shortcut field).
 * `skills` is optional — omit (or pass []) where skills shouldn't be insertable
 * (e.g. inside the skill-body editor, to forbid a skill embedding itself). */
export function gatherCommands(
  shortcuts: Shortcut[],
  tools: AdapterCommand[],
  skills: Skill[] = [],
  opts?: { builtins?: boolean },
): {
  builtins: CommandItem[];
  shortcuts: CommandItem[];
  skills: CommandItem[];
  tools: CommandItem[];
} {
  return {
    builtins: opts?.builtins
      ? BUILTIN_COMMANDS.map((b) => ({
          kind: 'builtin' as const,
          id: b.id,
          name: b.id,
          label: b.label,
          desc: b.desc,
          builtin: b,
        }))
      : [],
    shortcuts: shortcuts.map((s) => ({
      kind: 'shortcut',
      id: s.id,
      name: s.label,
      label: s.label,
      desc: s.kind === 'prompt' ? (s.text ?? '').slice(0, 80) : `Run tool ${s.tool ?? ''}`.trim(),
      shortcut: s,
    })),
    skills: skills.map((s) => ({
      kind: 'skill' as const,
      id: s.id,
      name: s.name,
      label: s.name,
      desc: s.description || (s.body ?? '').slice(0, 80),
      skill: s,
    })),
    tools: tools.map((t) => ({
      kind: 'tool',
      id: t.tool,
      name: t.tool,
      label: t.tool,
      desc: t.description,
    })),
  };
}

/** Case-insensitive substring filter over label + desc. */
export function filterCommands(items: CommandItem[], q: string): CommandItem[] {
  const s = q.trim().toLowerCase();
  if (!s) return items;
  return items.filter(
    (i) => i.label.toLowerCase().includes(s) || (i.desc ?? '').toLowerCase().includes(s),
  );
}
