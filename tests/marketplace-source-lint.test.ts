/**
 * Lint invariants for marketplace adapter sources.
 *
 * marketplace/<site>/<name>.js is hand-maintained as of commit `e9c211c`.
 * The runtime strips every `import ...;` line and injects a fixed set of
 * unsuffixed names into the eval scope (cli, Strategy, AuthRequiredError,
 * CommandExecutionError, EmptyResultError, ArgumentError, RateLimitedError,
 * __nodeShim, …). Anything in adapter code that references a name NOT in
 * that set explodes at runtime — but typically only when the failing branch
 * actually runs, which is exactly the failure mode adapter-hot-plug §10.14
 * describes.
 *
 * These tests catch two regression shapes statically by scanning the source
 * tree, so a future hand-edit (or an accidental re-run of build script with
 * --i-know-this-wipes-local-edits) can't reintroduce them silently:
 *
 *   1. esbuild-style `X2`/`X3` numeric-suffixed alias of an opencli error
 *      name — caused §10.14.
 *   2. Duplicate import lines from the SAME @jackwener/opencli/* module
 *      within a single file — the upstream cause that forces esbuild to
 *      alias.
 */
import { describe, expect, it } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MARKETPLACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'marketplace');

const OPENCLI_ERROR_NAMES = [
  'AuthRequiredError',
  'CommandExecutionError',
  'EmptyResultError',
  'ArgumentError',
  'RateLimitedError',
] as const;

async function walkAdapterFiles(): Promise<Array<{ rel: string; src: string }>> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const site of (await readdir(MARKETPLACE_ROOT)).sort()) {
    const sitePath = join(MARKETPLACE_ROOT, site);
    let s;
    try {
      s = await stat(sitePath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    for (const file of (await readdir(sitePath)).sort()) {
      if (!file.endsWith('.js')) continue;
      const src = await readFile(join(sitePath, file), 'utf8');
      out.push({ rel: `${site}/${file}`, src });
    }
  }
  return out;
}

describe('marketplace source lint', () => {
  it('no adapter source references an esbuild-aliased opencli error name', async () => {
    const files = await walkAdapterFiles();
    const aliasRe = new RegExp(`\\b(${OPENCLI_ERROR_NAMES.join('|')})[2-9]\\b`);
    const offenders: Array<{ file: string; match: string }> = [];
    for (const { rel, src } of files) {
      const m = src.match(aliasRe);
      if (m) offenders.push({ file: rel, match: m[0] });
    }
    expect(offenders).toEqual([]);
  });

  it('no adapter source has duplicate imports from the same @jackwener/opencli/* module', async () => {
    const files = await walkAdapterFiles();
    const offenders: Array<{ file: string; module: string; count: number }> = [];
    for (const { rel, src } of files) {
      const importRe = /^\s*import\s+(?:[^;'"`]+\s+from\s+)?["'](@jackwener\/opencli\/[^"']+)["']\s*;?\s*$/gm;
      const counts = new Map<string, number>();
      for (const m of src.matchAll(importRe)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      for (const [mod, n] of counts) {
        if (n > 1) offenders.push({ file: rel, module: mod, count: n });
      }
    }
    expect(offenders).toEqual([]);
  });
});
