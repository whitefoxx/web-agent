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
    .replace(
      // import https from 'node:https';  →  const https = __nodeShim['node:https'];
      // Adapter NAMES node:* but doesn't necessarily call into it. The shim
      // (src/runtime/node-shim.ts) injects real impls for the ones we
      // support (md5) and throws for the rest. See hot-plug §10.13.
      /^([ \t]*)import\s+(\w+)\s+from\s+['"](node:[^'"]+)['"]\s*;?[ \t]*$/gm,
      "$1const $2 = __nodeShim['$3'];",
    )
    .replace(
      // import { createHash } from 'node:crypto';  →  const { createHash } = __nodeShim['node:crypto'];
      /^([ \t]*)import\s+(\{[^}]+\})\s+from\s+['"](node:[^'"]+)['"]\s*;?[ \t]*$/gm,
      "$1const $2 = __nodeShim['$3'];",
    )
    .replace(
      // import('node:crypto')  →  __nodeShim['node:crypto']
      // `await` on a non-Promise is a no-op, so `await import(...)` works.
      /import\s*\(\s*['"](node:[^'"]+)['"]\s*\)/g,
      "__nodeShim['$1']",
    )
    .replace(/^[ \t]*import\s+[^;]*;[ \t]*$/gm, '') // import { x } from 'y';
    .replace(/^[ \t]*import\s+['"][^'"]+['"];[ \t]*$/gm, '') // import 'side-effect';
    .replace(/^[ \t]*export\s+default\s+/gm, '')
    .replace(/^([ \t]*)export\s+(?=function|const|let|var|class|async)/gm, '$1')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, ''); // export { a, b };
}

import { buildAdapterScope } from '../runtime/adapter-scope';

/** Build the curated global scope injected into the eval. A fresh collector
 * array is closed over by `cli`, so each call captures only what THIS source
 * registers. Delegates to the shared `buildAdapterScope` (one definition for
 * both the capture and runtime venues — see adapter-scope.ts / hot-plug §10.18).
 * Capture never runs func bodies, so the real utils/errors are unused here, but
 * sharing one scope is what stops the two from drifting again. */
function buildScope(collected: Record<string, unknown>[]): Record<string, unknown> {
  return buildAdapterScope((def) => collected.push(def));
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
    // `new Function` is the eval mechanism; permitted here because this file
    // only ever runs inside the MV3 sandboxed iframe (unsafe-eval CSP).
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
