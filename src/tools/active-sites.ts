/**
 * Session-active sites — which sites' adapter schemas should be EXPANDED in the
 * model-facing tool catalog (tool-select narrowing keeps generic tools + active
 * sites; everything else is compressed into a one-line digest).
 *
 * A site becomes active when the run shows real interest in it:
 *  - the user's text names it (tool-select match → api-engine marks it),
 *  - find_adapters returns hits for it (the model just asked about it),
 *  - load_adapter loads one of its adapters (explicit opt-in).
 *
 * SW-lifetime by design: narrowing is a soft token optimization, and carrying a
 * recently-used site's schemas into the next turn / session is exactly what we
 * want ("continue" turns keep their tools). The set is small (sites actually used),
 * and an SW restart simply resets to the narrow default.
 */

const active = new Set<string>();

export function markSiteActive(site: string): void {
  if (site && site !== 'generic') active.add(site);
}

export function getActiveSites(): ReadonlySet<string> {
  return active;
}

/** Test-only. */
export function __resetActiveSites(): void {
  active.clear();
}
