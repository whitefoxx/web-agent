/**
 * Per-key async serialization (parallel-execution v1 safety).
 *
 * When subagents run in parallel (api-engine fan-out), their tool calls reach
 * the dispatcher concurrently. Two concurrent calls that share a tab — a site
 * adapter's per-site tab, or a generic tool's `tab_id` — would double-attach
 * CDP / corrupt page state. `withKeyLock` queues same-key work so it runs one
 * at a time, while different keys (different sites/tabs, tab-less HTTP) run
 * fully in parallel. See docs/parallel-execution.md §5.
 *
 * Kept dep-free (no chrome / dispatcher imports) so it's unit-testable.
 */

const keyLocks = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();
  // Run fn once the previous same-key task settles (success OR failure).
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  // The stored tail must never reject, or one failure would wedge the chain.
  keyLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
