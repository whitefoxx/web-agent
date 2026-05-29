#!/usr/bin/env node
/**
 * Build a self-contained adapter marketplace index from a local opencli
 * checkout.
 *
 * Why self-contained (source inlined, not a sourceUrl): opencli's upstream
 * repo isn't a reachable public raw host, and this project's own repo is
 * private — so a per-file URL scheme can't be fetched from the extension. One
 * JSON artifact with the source embedded sidesteps hosting entirely: the
 * marketplace is a single file the operator can host anywhere (gist, gh-pages,
 * S3, a CDN, or a public mirror repo), and the extension installs from the
 * embedded source via the same sandbox-eval path as paste-install.
 *
 * Usage:
 *   node scripts/build-marketplace-index.mjs [--clis <dir>] [--out <file>] [--all]
 *
 * Defaults: --clis ../browser-agent/opencli/clis  --out marketplace/index.json
 * By default emits PIPELINE-type adapters only (the ones that actually run
 * post-install in Phase A). Pass --all to also include func-type (listed but
 * not runnable until Phase B).
 *
 * Each entry: { site, name, description, access, domain, type, source }.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const includeAll = process.argv.includes('--all');
const clisDir = resolve(arg('--clis', join(ROOT, '..', 'browser-agent', 'opencli', 'clis')));
const outFile = resolve(arg('--out', join(ROOT, 'marketplace', 'index.json')));

if (!existsSync(clisDir)) {
  console.error(`✗ clis dir not found: ${clisDir}`);
  console.error('  pass --clis <path-to-opencli/clis>');
  process.exit(1);
}

/** Pull a string/quoted field out of a cli({...}) call via regex. Good enough
 * for the well-formatted opencli corpus; we don't need a full JS parser to
 * read site/name/description/access/domain. */
function field(src, key) {
  const m = src.match(new RegExp(`\\b${key}\\s*:\\s*(['"\\\`])([^'"\\\`]*)\\1`));
  return m ? m[2] : undefined;
}

/** Classify by presence of `pipeline:` array vs `func:`. */
function classify(src) {
  const hasPipeline = /\bpipeline\s*:\s*\[/.test(src);
  const hasFunc = /\bfunc\s*:/.test(src);
  if (hasPipeline) return 'pipeline';
  if (hasFunc) return 'func';
  return 'unknown';
}

/** Node builtins / unshimmed opencli subpaths mean it can't run in-extension. */
function isInstallable(src) {
  if (/from\s+['"]node:/.test(src)) return false;
  if (/@jackwener\/opencli\/(download|browser|launcher)/.test(src)) return false;
  return true;
}

const SKIP = (f) => f.startsWith('_') || /\.(test|spec)\.[cm]?js$/.test(f) || f.endsWith('.d.ts');

async function main() {
  const sites = (await readdir(clisDir)).filter((d) => !d.startsWith('.'));
  const entries = [];
  let scanned = 0;
  let skipped = 0;

  for (const site of sites) {
    const siteDir = join(clisDir, site);
    if (!(await stat(siteDir)).isDirectory()) continue;
    for (const file of await readdir(siteDir)) {
      if (!file.endsWith('.js') || SKIP(file)) continue;
      const full = join(siteDir, file);
      const src = await readFile(full, 'utf8');
      if (!/\bcli\s*\(\s*\{/.test(src)) continue; // not an adapter file
      scanned++;

      const type = classify(src);
      if (!includeAll && type !== 'pipeline') {
        skipped++;
        continue;
      }
      if (!isInstallable(src)) {
        skipped++;
        continue;
      }

      entries.push({
        site: field(src, 'site') ?? site,
        name: field(src, 'name') ?? basename(file, '.js'),
        description: field(src, 'description') ?? '',
        access: field(src, 'access') ?? 'read',
        domain: field(src, 'domain'),
        type,
        source: src,
      });
    }
  }

  entries.sort((a, b) => (a.site + a.name).localeCompare(b.site + b.name));

  const index = {
    version: 1,
    generatedFrom: 'opencli/clis',
    includeAll,
    count: entries.length,
    adapters: entries,
  };

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(index, null, 2));
  const bytes = JSON.stringify(index).length;
  console.log(`✓ ${outFile}`);
  console.log(
    `  ${entries.length} adapters (${type_breakdown(entries)}) · scanned ${scanned} · skipped ${skipped} · ${(bytes / 1024).toFixed(0)} KB`,
  );
}

function type_breakdown(entries) {
  const byType = {};
  for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
  return Object.entries(byType)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
