/**
 * Ephemeral ("try it once") adapters (T7, direction 1).
 *
 * Fetch a marketplace adapter's source, eval it (via the offscreen document — no
 * side panel needed), and register it into the LIVE registry **without persisting**
 * (`registerSessionDefs`). The adapter is then a first-class, schema'd tool for
 * this session — `<site>__<name>` shows up in the catalog with real args — but is
 * gone on SW restart and never joins the user's trusted *installed* set.
 *
 * Difference from install: no persistence, no extra consent to load (the eval is
 * sandboxed + the source is sha256-verified, same as install); a WRITE adapter
 * still asks for confirmation when it actually runs. Keep the installed set lean
 * (every installed adapter is in the tool catalog on every LLM call = tokens);
 * load infrequent ones on demand instead.
 */

import { fetchMarketIndex, fetchAdapterSource } from '@base/core/marketplace';
import { registerSessionDefs } from '../adapters/install-manager';
import { markSiteActive } from '../tools/active-sites';
import { allAdapterCommands } from '@base/tools/manifest';
import type { CapturedDef } from '../adapters/installed-store';
import type { AdapterCommand } from '../messages';
import { evalAdapterViaOffscreen } from './offscreen-eval';

/** Tools registered ephemerally (this SW lifetime) — lets the write-confirm path
 * label them "ephemeral/not installed". */
const ephemeralTools = new Set<string>();
export function isEphemeralTool(tool: string): boolean {
  return ephemeralTools.has(tool);
}

export interface LoadAdapterArg {
  name: string;
  type?: string;
  required?: boolean;
  help?: string;
}
export interface LoadAdapterResult {
  ok: boolean;
  tool?: string;
  access?: 'read' | 'write';
  description?: string;
  args?: LoadAdapterArg[];
  /** All commands the loaded source registered (so a UI can offer a run panel). */
  commands?: AdapterCommand[];
  note?: string;
  error?: string;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Load a marketplace adapter for this session only (no install). Returns the
 * adapter's real arg schema so the caller knows how to invoke `<site>__<name>`
 * (which is now a registered tool). */
export async function loadEphemeralAdapter(
  siteRaw: string,
  nameRaw: string,
): Promise<LoadAdapterResult> {
  const site = siteRaw.trim();
  const name = nameRaw.trim();
  if (!site || !name) return { ok: false, error: 'load_adapter needs site and name' };

  let entry;
  try {
    // forceFresh: the entry's sha256 must match the freshly-fetched source below
    // (a stale cached index would mismatch after a marketplace update). §10.15.
    const index = await fetchMarketIndex({ forceFresh: true });
    entry = index.adapters.find((a) => a.site === site && a.name === name);
  } catch (e) {
    return { ok: false, error: `marketplace index fetch failed: ${msg(e)}` };
  }
  if (!entry) {
    return { ok: false, error: `marketplace has no ${site}/${name} (use find_adapters first)` };
  }

  // sha256-verified inside fetchAdapterSource (throws on mismatch) — integrity is
  // NOT relaxed for ephemeral loads.
  let source: string;
  try {
    source = await fetchAdapterSource(entry);
  } catch (e) {
    return { ok: false, error: `fetch/verify failed: ${msg(e)}` };
  }

  const evaled = await evalAdapterViaOffscreen(source);
  if (!evaled.ok || !evaled.defs.length) {
    return { ok: false, error: evaled.error ?? 'source registered no cli() adapter' };
  }

  let registered: number;
  try {
    registered = registerSessionDefs(evaled.defs as CapturedDef[], source);
  } catch (e) {
    return { ok: false, error: `register failed: ${msg(e)}` };
  }
  if (registered === 0) {
    return {
      ok: false,
      // Actionable instruction, not a bare error (adapter-hot-plug §10.39): the
      // model saw the old string, mentioned it once mid-task, then dropped it —
      // the user's final answer never told them how to make this one-shot. Tell
      // the model to fall back to generic tools AND surface the enable-guidance
      // in its final reply so it works next time.
      error:
        'Load failed: this func-type adapter needs Chrome\'s "Allow user scripts" switch (enable it on this extension\'s details page at chrome://extensions, then reload the extension). Please complete this task with the generic tools instead, and in **your final reply to the user** add one sentence guiding them to turn on that switch — once enabled, this kind of site adapter works in a single step, for convenience going forward.',
    };
  }

  const loaded = new Set(evaled.defs.map((d) => `${d.site}__${d.name}`));
  for (const t of loaded) ephemeralTools.add(t);
  // Explicit opt-in to this site — keep its schemas expanded in the narrowed
  // tool catalog for the rest of the session (tool-select v2).
  for (const d of evaled.defs) markSiteActive(String(d.site ?? ''));
  const commands = allAdapterCommands().filter((c) => loaded.has(c.tool));
  const def =
    evaled.defs.find((d) => `${d.site}__${d.name}` === `${site}__${name}`) ?? evaled.defs[0];
  const tool = `${def.site}__${def.name}`;
  const args: LoadAdapterArg[] = Array.isArray(def.args)
    ? (def.args as Record<string, unknown>[]).map((a) => ({
        name: String(a.name ?? ''),
        type: typeof a.type === 'string' ? a.type : 'string',
        required: a.required === true,
        ...(typeof a.help === 'string' ? { help: a.help } : {}),
      }))
    : [];

  return {
    ok: true,
    tool,
    access: def.access,
    description: def.description,
    args,
    commands,
    note: `Loaded ephemerally (not installed, gone on SW restart). You can now call the tool ${tool} directly.`,
  };
}
