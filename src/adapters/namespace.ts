/**
 * Self-explored adapter namespacing.
 *
 * Marketplace adapters and self-explored ones share the same underlying website
 * (e.g. both could target `xiaohongshu`), so without separation an explored
 * `xiaohongshu/search` would collide with the marketplace `xiaohongshu/search`
 * in the registry (de-dupes on `site/name`, last-write-wins) and the
 * installed-store (keyed by `site/name`) — silently shadowing one with the other.
 *
 * Resolution (chosen 2026-06): explored adapters live in a SEPARATE namespace —
 * their `site` carries a reserved prefix (`my-`), so their tool id becomes
 * `my-xiaohongshu__search` and can never clash with the marketplace pool. The
 * prefix is purely an identity concern: the dispatcher strips it via `baseSite`
 * before resolving the target tab / pacing, so routing is identical to the
 * un-prefixed site. See docs/architecture.md §15.
 *
 * The prefix must NOT contain `__` (that's the `site__name` tool-id separator,
 * split on the FIRST `__` in manifest.ts:lookupAdapter), and a single `-` keeps
 * the tool name within OpenAI's `^[a-zA-Z0-9_-]{1,64}$` constraint.
 */

export const EXPLORED_SITE_PREFIX = 'my-';

/** True when a site string is in the explored namespace. */
export function isExploredSite(site: string): boolean {
  return site.startsWith(EXPLORED_SITE_PREFIX);
}

/** Move a site into the explored namespace (idempotent). */
export function toExploredSite(site: string): string {
  return isExploredSite(site) ? site : `${EXPLORED_SITE_PREFIX}${site}`;
}

/** The real website site key (for tab routing / pacing), stripping the explored
 * namespace marker if present. Built-in / marketplace sites pass through. */
export function baseSite(site: string): string {
  return isExploredSite(site) ? site.slice(EXPLORED_SITE_PREFIX.length) : site;
}
