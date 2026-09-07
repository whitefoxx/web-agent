/**
 * Wrap every case-insensitive occurrence of `q` in `text` with a <mark> so the
 * matched substring pops while searching. Shared by history search (App.tsx) and
 * the adapter market search (Adapters.tsx).
 */
export function highlightMatches(text: string, q: string): preact.ComponentChildren {
  const query = q.trim();
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: preact.ComponentChildren[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const at = lower.indexOf(needle, i);
    if (at === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark key={k++} class="search-hl">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    i = at + needle.length;
  }
  return parts;
}
