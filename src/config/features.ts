/**
 * Product feature gates — the shipping "product" build hides a few advanced
 * features for a simpler first release. Flip a flag back to `true` to restore
 * the corresponding feature everywhere it's gated (menu entry + agent tool +
 * prompt + runtime). See docs/product-hidden-features.md for the full map and
 * the restore checklist.
 *
 * On the `main` branch these are all `true`; the `product` branch ships them
 * `false`. Keeping the gate here (rather than deleting code) means restoring is
 * a one-line change per feature and `main`↔`product` merges only ever touch
 * this file for the toggle itself.
 *
 * KEEP THIS MODULE DEPENDENCY-FREE — it is imported from the content-script
 * bundle, the SidePanel, the background SW, and the agent engine.
 */
export const FEATURES = {
  /** My Memory — long-term memory: the "My Memory" page, the `update_memory` tool,
   * and the single memory document injected into the system prompt. Restored to
   * the product build 2026-07-17 (reworked from a fact-list to one blob). */
  memory: true,
  /** My Notes — the "My Notes" page and the `notes` tool (markdown notebook). */
  notes: false,
  /** Credentials — the "Credentials & redaction" page (user-supplied secrets
   * injected into adapter runs). With the page hidden no secrets can be added, so
   * injection is inert. */
  secrets: false,
  /** Selection toolbar — the text-selection toolbar content script, the "Selection
   * toolbar" page, and the `get_highlights` agent tool. */
  selectionToolbar: false,
} as const;
