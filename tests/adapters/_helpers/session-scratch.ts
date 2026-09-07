/**
 * Test helper for the §10.22 cross-navigation scratchpad pattern.
 *
 * Interleaved hot-plug adapters (read page A → navigate → read page B, both into
 * the result) carry A's snapshot across the navigate+reinject by stashing it in
 * the tab's sessionStorage. In a unit test the fake `page.goto` does NOT throw
 * NAVIGATE_RESTART, so the state-machine func runs linearly in one call — but it
 * still calls sessionStorage.setItem(...) then later getItem(...). This wrapper
 * makes those calls work: it intercepts the scratchpad scripts (emitted by the
 * adapters' buildScratch{Set,Get,Clear}Script helpers) against an in-memory
 * store and falls through to `scrape` for every real extraction script. The
 * store lives for the life of the returned fn, mirroring a same-origin tab's
 * sessionStorage surviving the navigation.
 */
import { vi, type Mock } from 'vitest';

export function withSessionScratch(scrape: (script: string) => unknown): Mock {
  const store = new Map<string, string>();
  return vi.fn((script: string) => {
    const s = String(script);
    let m: RegExpMatchArray | null;
    if ((m = s.match(/sessionStorage\.setItem\((["'])(.+?)\1,\s*(".*")\)/s))) {
      store.set(m[2], JSON.parse(m[3]));
      return true;
    }
    if ((m = s.match(/sessionStorage\.getItem\((["'])(.+?)\1\)/))) {
      return store.has(m[2]) ? store.get(m[2]) : null;
    }
    if ((m = s.match(/sessionStorage\.removeItem\((["'])(.+?)\1\)/))) {
      store.delete(m[2]);
      return true;
    }
    return scrape(s);
  });
}
