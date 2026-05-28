/**
 * MAIN-world clipboard tap for chat.deepseek.com.
 *
 * Runs in the page's own JS context (NOT the isolated content-script world)
 * so it can monkey-patch `navigator.clipboard.writeText` before DeepSeek's
 * own code uses it. When DeepSeek's "Copy" button is clicked, its handler
 * calls writeText with the canonical markdown for that assistant turn — we
 * intercept that call, forward the text to the isolated-world connector
 * via window.postMessage, and still call the original implementation so
 * the system clipboard actually gets updated (the user expectation when
 * THEY click Copy themselves is preserved).
 *
 * Why this approach rather than reading the system clipboard:
 *   - No `clipboardRead` extension permission required.
 *   - Doesn't depend on the chat.deepseek.com tab having keyboard focus
 *     (the user is typing in the SidePanel — the chat tab is in the
 *     background, where Chrome refuses navigator.clipboard.readText anyway).
 *   - Doesn't clobber whatever the user already has on their clipboard.
 *
 * Loaded as a separate `content_scripts` entry with `"world": "MAIN"` and
 * `"run_at": "document_start"` so we patch BEFORE DeepSeek's bundle gets
 * a chance to grab `writeText` references.
 */

(function installClipboardTap(): void {
  const clip = (navigator as Navigator).clipboard as Clipboard | undefined;
  if (!clip || typeof clip.writeText !== 'function') return;

  const orig = clip.writeText.bind(clip);

  // Avoid double-install if this script ever runs twice (e.g. SW
  // re-injection after extension reload while the tab was already open).
  const TAGGED = '__webchatAgentTapped';
  if ((clip.writeText as unknown as Record<string, boolean>)[TAGGED]) return;

  const tapped = async function (text: string): Promise<void> {
    try {
      window.postMessage(
        { __webchatAgent: 'clipboard-write', text, ts: Date.now() },
        window.location.origin,
      );
    } catch {
      // Best-effort. Failing to fan out shouldn't break the real write.
    }
    return orig(text);
  };

  (tapped as unknown as Record<string, boolean>)[TAGGED] = true;
  try {
    clip.writeText = tapped;
  } catch {
    // Some hardened pages freeze clipboard — nothing we can do.
  }
})();
