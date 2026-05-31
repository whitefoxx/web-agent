/**
 * Type augmentation for `chrome.userScripts` features the bundled
 * @types/chrome (older release) doesn't know about yet:
 *   - `worldId` on configureWorld + execute (Chrome 138+)
 *   - `execute()` method itself (Chrome 135+)
 *
 * Strictly additive — re-uses the existing types where possible. When
 * @types/chrome catches up we can delete this file.
 */

declare namespace chrome.userScripts {
  interface WorldProperties {
    /** Distinct named USER_SCRIPT world (Chrome 138+). Lets us host our runner
     * in an isolated CSP without clobbering whatever the user's other user
     * scripts may have configured for the default world. */
    worldId?: string;
  }

  interface InjectionTarget {
    tabId: number;
    frameIds?: number[];
    documentIds?: string[];
    allFrames?: boolean;
  }

  interface ScriptInjection {
    target: InjectionTarget;
    /** USER_SCRIPT (default) | MAIN. We always use USER_SCRIPT. */
    world?: ExecutionWorld;
    /** Optional named world (Chrome 138+). */
    worldId?: string;
    /** Run at document_start instead of document_idle. */
    injectImmediately?: boolean;
    js: ScriptSource[];
  }

  interface InjectionResult {
    documentId: string;
    frameId: number;
    result?: unknown;
    error?: { message: string };
  }

  /** Chrome 135+ — programmatic one-shot inject. */
  function execute(injection: ScriptInjection): Promise<InjectionResult[]>;
}
