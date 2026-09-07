/**
 * The single source of truth for the global scope injected into an opencli
 * adapter when it's eval'd from a marketplace source string.
 *
 * WHY THIS EXISTS (docs/adapter-hot-plug.md §10.18): there used to be TWO
 * hand-maintained copies of this scope —
 *   - `src/sandbox/eval-core.ts buildScope()`        (install-time CAPTURE)
 *   - `src/userscript/run-in-page.ts evalAdapterKeepingFuncs()` (RUNTIME func)
 * They drifted. The runtime copy injected STUBS for the opencli utils
 * (`htmlToMarkdown = (v)=>v`, `mapConcurrent = async ()=>[]`, …) and LOCAL
 * `mkErr` error stand-ins. Consequences, all invisible to the test suite
 * (vitest resolves the REAL utils via alias, so tests passed):
 *   - chatgpt/detail etc. returned raw HTML instead of markdown (stub passthrough)
 *   - any func using `mapConcurrent` got `[]`
 *   - `log` wasn't injected at all → ReferenceError in weread/shelf, zhihu/collection
 *   - `createMarkdownConverter` was in the capture scope but not the runtime one
 *   - dispatcher's `e instanceof AuthRequiredError` (real class) was ALWAYS false
 *     for thrown adapter errors (they were local stand-ins), so login / rate-limit
 *     / empty-result UX never fired for installed func adapters.
 *
 * Both venues now call buildAdapterScope(), injecting the REAL errors, REAL
 * utils, and REAL log. The capture path doesn't execute func bodies so it
 * never needed the real impls, but sharing one definition is what stops the
 * drift from coming back (the §10.16 lesson: put "what the adapter can see" in
 * ONE place).
 *
 * Safe in both venues: utils are pure string/DOM transforms (no fetch / chrome),
 * `log` routes through runtime/log which guards `typeof chrome` so it degrades
 * to console in the sandbox iframe, and errors are plain classes.
 */

import { nodeShim } from './node-shim';
import {
  isRecord,
  sleep,
  mapConcurrent,
  htmlToMarkdown,
  createMarkdownConverter,
  throwIfLoginWall,
  parseJsonOrThrowLoginWall,
  BROWSER_JSON_SNIFF_FN,
} from './opencli/utils';
import { log } from './opencli/logger';
import {
  CliError,
  ArgumentError,
  TimeoutError,
  AuthRequiredError,
  EmptyResultError,
  BrowserConnectError,
  ConfigError,
  CommandExecutionError,
  LoginWallError,
  RateLimitedError,
  NeedsAttachmentsError,
  NotImplementedError,
  NavigationError,
  ResourceConflictError,
  BugError,
} from '@base/runtime/errors.js';

/** Strategy enum, byte-aligned with opencli (+ legacy DIRECT/AUTO aliases). */
export const Strategy = Object.freeze({
  PUBLIC: 'public',
  LOCAL: 'local',
  COOKIE: 'cookie',
  INTERCEPT: 'intercept',
  UI: 'ui',
  DIRECT: 'direct',
  AUTO: 'auto',
});

/**
 * Build the curated globals an adapter source sees when eval'd. `onRegister`
 * is called for every `cli({...})` the source executes at module-eval time —
 * the CAPTURE path pushes serializable defs, the RUNTIME path keeps the live
 * (func-bearing) defs.
 */
export function buildAdapterScope(
  onRegister: (def: Record<string, unknown>) => void,
): Record<string, unknown> {
  const cli = (def: Record<string, unknown>) => {
    if (!def || typeof def !== 'object') throw new Error('cli() expects an object');
    if (!def.site || !def.name) throw new Error('cli() definition missing site/name');
    onRegister(def);
    return def;
  };

  return {
    cli,
    Strategy,
    registerCommand: cli,
    fullName: (c: { site: string; name: string }) => `${c.site}/${c.name}`,
    onStartup: () => {},
    onBeforeExecute: () => {},
    onAfterExecute: () => {},

    // Error classes — the REAL ones from runtime/errors.js, so the dispatcher's
    // `e instanceof AuthRequiredError / RateLimitedError / EmptyResultError`
    // checks recognize what an adapter throws (they share this module instance).
    CliError,
    ArgumentError,
    TimeoutError,
    AuthRequiredError,
    EmptyResultError,
    BrowserConnectError,
    ConfigError,
    CommandExecutionError,
    LoginWallError,
    RateLimitedError,
    NeedsAttachmentsError,
    NotImplementedError,
    NavigationError,
    ResourceConflictError,
    BugError,
    selectorError: (sel: string) => new CommandExecutionError(`selector failed: ${sel}`),
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),

    // Utils — the REAL implementations (turndown-backed markdown, real
    // concurrency limiter, real login-wall sniffing). Adapters that call these
    // at runtime now get correct output instead of identity/empty stubs.
    isRecord,
    htmlToMarkdown,
    createMarkdownConverter,
    throwIfLoginWall,
    parseJsonOrThrowLoginWall,
    sleep,
    mapConcurrent,
    BROWSER_JSON_SNIFF_FN,
    EXIT_CODES: {},

    // Logger — `log.info/.warn/.error/.debug/.success`, routed to runtime/log.
    log,

    // node:* lookup map — stripModuleSyntax rewrites `import x from 'node:y'`
    // to `const x = __nodeShim['node:y']`, so this name must be in scope.
    __nodeShim: nodeShim,
  };
}
