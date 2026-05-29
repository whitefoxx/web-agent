/**
 * Sandbox eval core — the risky bit of runtime adapter installation, factored
 * out as a PURE function so it can be unit-tested in node (vitest) even though
 * the real execution venue is a sandboxed iframe.
 *
 * What it does: take an UNMODIFIED opencli adapter source string, neutralize
 * its ES-module syntax (imports/exports can't appear in a `new Function` body),
 * run it with a curated set of injected globals (`cli`, `Strategy`, error
 * classes, util stubs), and capture whatever `cli({...})` definitions it
 * registers — serialized to plain, structured-clone-safe data.
 *
 * Security: this is only ever invoked inside the sandboxed iframe (MV3
 * `sandbox.pages`, opaque origin, NO `chrome.*`). `new Function` is permitted
 * there by the sandbox CSP's `'unsafe-eval'`. The injected scope deliberately
 * exposes nothing dangerous — no `fetch`, no `chrome`, no `globalThis` handle
 * beyond standard JS built-ins the adapter body might touch at module-eval
 * time (it won't: pipeline adapters just call `cli({...})`).
 */

/** A captured adapter definition, stripped to serializable data.
 * `func` (a closure) cannot cross postMessage, so it's dropped; `hasFunc`
 * records whether the source defined one. `kind` classifies for the installer:
 * pipeline adapters run via our interpreter; func adapters need Phase B. */
export interface CapturedAdapter {
  site: string;
  name: string;
  access?: 'read' | 'write';
  description?: string;
  domain?: string;
  strategy?: string;
  args?: unknown[];
  columns?: string[];
  pipeline?: unknown[];
  navigateBefore?: unknown;
  siteSession?: string;
  kind: 'pipeline' | 'func' | 'unknown';
  hasFunc: boolean;
}

export interface EvalResult {
  ok: boolean;
  defs: CapturedAdapter[];
  /** Names referenced by the source that weren't in the injected scope —
   * a heuristic hint when eval fails with a ReferenceError. */
  error?: string;
}

/**
 * Neutralize ES-module syntax so the source can run as a `new Function` body.
 *  - drop every `import ...;` line (symbols come from the injected scope)
 *  - strip the `export` keyword from `export function/const/let/var/class/async`
 *  - drop `export default ` and standalone `export { ... };`
 * opencli adapters always use semicolon-terminated single-line imports, so a
 * line-oriented transform is sufficient and predictable.
 */
export function stripModuleSyntax(src: string): string {
  return src
    .replace(/^[ \t]*import\s+[^;]*;[ \t]*$/gm, '') // import { x } from 'y';
    .replace(/^[ \t]*import\s+['"][^'"]+['"];[ \t]*$/gm, '') // import 'side-effect';
    .replace(/^[ \t]*export\s+default\s+/gm, '')
    .replace(/^([ \t]*)export\s+(?=function|const|let|var|class|async)/gm, '$1')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, ''); // export { a, b };
}

/** Build the curated global scope injected into the eval. A fresh collector
 * array is closed over by `cli`, so each call captures only what THIS source
 * registers. */
function buildScope(collected: Record<string, unknown>[]): Record<string, unknown> {
  const Strategy = Object.freeze({
    PUBLIC: 'public',
    LOCAL: 'local',
    COOKIE: 'cookie',
    INTERCEPT: 'intercept',
    UI: 'ui',
    DIRECT: 'direct',
    AUTO: 'auto',
  });
  function cli(def: Record<string, unknown>) {
    if (!def || typeof def !== 'object') throw new Error('cli() expects an object');
    if (!def.site || !def.name) throw new Error('cli() definition missing site/name');
    collected.push(def);
    return def;
  }
  const registerCommand = (d: Record<string, unknown>) => cli(d);
  const fullName = (c: { site: string; name: string }) => `${c.site}/${c.name}`;
  const noop = () => {};

  // Error classes: adapters reference these only inside `func` bodies (which we
  // never execute during capture), but the NAMES must resolve at module-eval
  // time if referenced at top level. Minimal stand-ins keep eval from throwing.
  class CliError extends Error {}
  const mkErr = (name: string) =>
    class extends CliError {
      constructor(...args: unknown[]) {
        super(typeof args[0] === 'string' ? args[0] : name);
        this.name = name;
        void args;
      }
    };

  // Util stubs: same reasoning — only used inside func bodies. Provide harmless
  // implementations so top-level references resolve. (No `fetch`, no chrome.)
  const isRecord = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const passthrough = <T>(v: T) => v;

  return {
    cli,
    Strategy,
    registerCommand,
    fullName,
    onStartup: noop,
    onBeforeExecute: noop,
    onAfterExecute: noop,
    // errors
    CliError,
    ArgumentError: mkErr('ArgumentError'),
    AuthRequiredError: mkErr('AuthRequiredError'),
    EmptyResultError: mkErr('EmptyResultError'),
    RateLimitedError: mkErr('RateLimitedError'),
    CommandExecutionError: mkErr('CommandExecutionError'),
    ConfigError: mkErr('ConfigError'),
    TimeoutError: mkErr('TimeoutError'),
    LoginWallError: mkErr('LoginWallError'),
    NeedsAttachmentsError: mkErr('NeedsAttachmentsError'),
    selectorError: (sel: string) => new CliError(`selector: ${sel}`),
    getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    // utils
    isRecord,
    htmlToMarkdown: passthrough,
    createMarkdownConverter: () => ({ turndown: (s: string) => s }),
    throwIfLoginWall: passthrough,
    parseJsonOrThrowLoginWall: passthrough,
    sleep: () => Promise.resolve(),
    mapConcurrent: async () => [],
    BROWSER_JSON_SNIFF_FN: '',
    EXIT_CODES: {},
  };
}

/** Classify + strip a captured raw def to serializable `CapturedAdapter`. */
function serializeDef(def: Record<string, unknown>): CapturedAdapter {
  const hasFunc = typeof def.func === 'function';
  const hasPipeline = Array.isArray(def.pipeline) && (def.pipeline as unknown[]).length > 0;
  const plain: Record<string, unknown> = {};
  for (const k of Object.keys(def)) {
    if (k === 'func') continue;
    const v = def[k];
    if (typeof v === 'function') continue; // drop any stray functions (footerExtra, validateArgs…)
    plain[k] = v;
  }
  // Guarantee structured-clone safety by round-tripping the data payload.
  let safe: Record<string, unknown>;
  try {
    safe = JSON.parse(JSON.stringify(plain));
  } catch {
    safe = { site: def.site, name: def.name };
  }
  return {
    ...(safe as Omit<CapturedAdapter, 'kind' | 'hasFunc'>),
    kind: hasPipeline ? 'pipeline' : hasFunc ? 'func' : 'unknown',
    hasFunc,
  };
}

/**
 * Run an opencli adapter source string and capture its `cli()` registrations.
 * Pure and side-effect-free (beyond the eval itself). Never throws — failures
 * come back as `{ ok:false, error }`.
 */
export function evalAdapterSource(src: string): EvalResult {
  const collected: Record<string, unknown>[] = [];
  const scope = buildScope(collected);
  const names = Object.keys(scope);
  const values = names.map((n) => scope[n]);
  const body = stripModuleSyntax(src);
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(...names, `"use strict";\n${body}`);
    fn(...values);
  } catch (e) {
    return { ok: false, defs: [], error: e instanceof Error ? e.message : String(e) };
  }
  if (collected.length === 0) {
    return { ok: false, defs: [], error: 'source did not register any adapter via cli()' };
  }
  return { ok: true, defs: collected.map(serializeDef) };
}
