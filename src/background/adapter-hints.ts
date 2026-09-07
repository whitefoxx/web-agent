/**
 * Just-in-time adapter hint — the "adapters first" rule enforced at the moment
 * it's being broken, instead of relying on the model remembering a prompt line.
 *

 * When the agent generic-drives a site that has marketplace adapters but NO
 * tool registered for it — opening a URL (`open_url`) or READING its content
 * (`get_page_text`; session s_mregtz8u showed the open
 * hint alone misses the read-an-already-open-tab path) — we append a one-line
 * hint to the tool RESULT pointing at find_adapters/load_adapter. The hint
 * rides the data the model is already reading (tool results get full
 * attention, long system prompts don't), fires exactly when the wrong path
 * starts, and is emitted at most once per (origin, site) so it never nags.
 */

import { fetchMarketIndex } from '@base/core/marketplace';
import { getRegistry } from '@base/runtime/registry.js';
import { baseSite } from '../adapters/namespace';
import { getActiveExploreSession } from '../explore/session';
import { siteFromHost } from '@base/tools/generic/open-url';

/** origin → sites already hinted (SW lifetime — a rehint after a restart is fine). */
const hinted = new Map<string, Set<string>>();

/** A hint for the model when `url`'s site has ready-made adapters the run isn't
 * using, or null (no adapters / already registered / already hinted). */
export async function adapterHintForUrl(
  origin: string | undefined,
  url: string,
): Promise<string | null> {
  // Exploring = deliberately driving the page with generic tools to SYNTHESIZE
  // an adapter — "use a ready-made one" would fight the mission.
  if (getActiveExploreSession()) return null;
  let site: string;
  try {
    site = siteFromHost(new URL(url).hostname);
  } catch {
    return null;
  }
  if (!site) return null;
  // A tool for this site is already registered (installed / session-loaded /
  // explored) → the model has what it needs; generic driving is a deliberate
  // choice, don't second-guess it.
  for (const def of getRegistry() as { site: string }[]) {
    if (baseSite(def.site) === site) return null;
  }
  const seen = hinted.get(origin ?? '') ?? new Set<string>();
  if (seen.has(site)) return null;
  let names: string[];
  try {
    const idx = await fetchMarketIndex(); // cache-first, 6h TTL — no hot-path cost
    names = idx.adapters.filter((a) => a.site === site).map((a) => a.name);
  } catch {
    return null; // offline / no index — silently skip
  }
  if (names.length === 0) return null;
  seen.add(site);
  hinted.set(origin ?? '', seen);
  const sample = names.slice(0, 8).join(' / ');
  return (
    `💡 Site ${site} has ${names.length} ready-made adapter(s) (${sample}${names.length > 8 ? ' …' : ''}). ` +
    `Don't brute-force data scraping / content reading with generic tools: find_adapters("${site}") → load_adapter gets it done in one step, faster and cheaper.`
  );
}

/** Test-only: reset the once-per-(origin,site) memory. */
export function __resetAdapterHints(): void {
  hinted.clear();
}
