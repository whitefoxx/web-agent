#!/usr/bin/env node
/**
 * Build a per-file adapter marketplace from a local opencli checkout.
 *
 * Layout produced (committed to repo, also copied verbatim to dist/ at build
 * time by vite.config.ts → sandboxPagePlugin):
 *
 *   marketplace/
 *     index.json                    # metadata only, no embedded source
 *     <site>/<name>.js              # bundled adapter source, one file per adapter
 *
 * Each index.json entry carries `source` as a RELATIVE path (e.g.
 * "zhihu/answer-detail.js") that the extension resolves against a base URL —
 * `chrome.runtime.getURL('marketplace/')` for the built-in shipped tree today,
 * an HTTPS URL for the future public/community marketplace. Same schema both
 * places; the only branch is which base the client uses.
 *
 * `sha256` is computed over the exact bytes the .js file contains and lets
 * the install client refuse a body that doesn't match what the index promised
 * (defends both built-in vs. tampered-dist and remote vs. man-in-the-middle /
 * post-review swap). Also doubles as upgrade detection — installed adapter's
 * sha256 differing from the index → "新版本可用".
 *
 * Usage:
 *   node scripts/build-marketplace-index.mjs [--clis <dir>] [--out <dir>] [--all|--popular]
 *
 * Defaults: --clis ../browser-agent/opencli/clis  --out marketplace/
 *   no flags:  pipeline only
 *   --popular: pipeline (all) + func (POPULAR_SITES allowlist only)
 *   --all:     everything
 *
 * Pre-cleans every site subdirectory of `--out` before regen so adapters removed
 * upstream don't linger as ghost .js files. `marketplace/index.json` is
 * overwritten.
 */

import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const includeAll = process.argv.includes('--all');
const popularOnly = process.argv.includes('--popular');
const clisDir = resolve(arg('--clis', join(ROOT, '..', 'browser-agent', 'opencli', 'clis')));
const outDir = resolve(arg('--out', join(ROOT, 'marketplace')));

/**
 * Curated allowlist used with --popular for the shipped built-in marketplace.
 * Edit this to tune the default; users can still paste-install anything else
 * by hand. All pipeline-only entries are kept regardless; func entries kept
 * only if their site is in this set.
 */
const POPULAR_SITES = new Set([
  // 国内主流
  'xiaohongshu',
  'bilibili',
  'zhihu',
  'weibo',
  'douyin',
  'weread',
  'weread-official',
  'douban',
  'v2ex',
  // 海外主流
  'twitter',
  'youtube',
  'reddit',
  'linkedin',
  'hackernews',
  'bluesky',
  'lobsters',
  // 论文 / 学术
  'arxiv',
  'pubmed',
  // 工具 / 行情
  'coingecko',
  'binance',
  'wikipedia',
  // AI 工具
  'notebooklm',
  'chatgpt',
  'claude',
  'gemini',
]);

// 当前不想内置的站点 — 直接跳过,不参与任何后续过滤。
const SKIP_SITES = new Set([
  'binance',
  'coingecko',
  'dictionary',
  'facebook',
  'hupu',
  'nowcoder',
  'pixiv',
  'pubmed',
  'steam',
  'xiaoe',
]);

if (!existsSync(clisDir)) {
  console.error(`✗ clis dir not found: ${clisDir}`);
  console.error('  pass --clis <path-to-opencli/clis>');
  process.exit(1);
}

/** Regex-grab a string field out of cli({...}). The opencli corpus is regular
 * enough that we don't need a real parser to read site/name/description/etc. */
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

/**
 * esbuild-bundle one adapter so sibling imports (e.g. `import { parseVideoId }
 * from './utils.js'`) get inlined. The runtime stripModuleSyntax drops every
 * import line, so any unresolved name becomes a ReferenceError after load —
 * §10.8 in docs/adapter-hot-plug.md.
 *
 * `@jackwener/opencli/*` stays external: the runtime injects those names
 * (cli/Strategy/errors) into the eval scope.
 */
async function bundleAdapterSource(entryPath) {
  const result = await esbuild({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'esnext',
    write: false,
    legalComments: 'none',
    // `@jackwener/opencli/*` stays external because the runtime injects those
    // names (cli/Strategy/errors) into the eval scope.
    // `node:*` stays external because stripModuleSyntax rewrites those imports
    // to lookups in the __nodeShim object (see src/runtime/node-shim.ts +
    // hot-plug §10.13). Without this, esbuild errors trying to resolve
    // node:crypto / node:https etc. and the script falls back to shipping the
    // raw source — which then errors at runtime with "getSelfUid is not
    // defined" because the relative-sibling imports never get inlined.
    external: ['@jackwener/opencli/*', 'node:*'],
    // Keep CJK / non-ASCII as UTF-8 in bundled output. esbuild defaults to
    // charset:'ascii' which escapes every Chinese char to `\uXXXX`, making the
    // shipped adapter source unreadable when inspected (runtime-equivalent
    // either way, but a real cost when humans read these files).
    charset: 'utf8',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

const SKIP = (f) => f.startsWith('_') || /\.(test|spec)\.[cm]?js$/.test(f) || f.endsWith('.d.ts');

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Drop every site subdir under outDir before regen, so adapters that were
 * removed upstream don't linger. Leaves the top-level index.json untouched
 * (it gets overwritten below); leaves anything else at root alone in case the
 * dir was being used for something else by hand. */
async function cleanSiteDirs(root) {
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await cleanSiteDirs(outDir);

  const sites = (await readdir(clisDir)).filter((d) => !d.startsWith('.'));
  const entries = [];
  let scanned = 0;
  let skipped = 0;
  let written = 0;

  for (const site of sites) {
    if (SKIP_SITES.has(site)) continue;
    const siteDir = join(clisDir, site);
    if (!(await stat(siteDir)).isDirectory()) continue;
    let siteOutMade = false;

    for (const file of await readdir(siteDir)) {
      if (!file.endsWith('.js') || SKIP(file)) continue;
      const full = join(siteDir, file);
      const src = await readFile(full, 'utf8');
      if (!/\bcli\s*\(\s*\{/.test(src)) continue;
      scanned++;

      const type = classify(src);
      if (!includeAll && !popularOnly && type !== 'pipeline') {
        skipped++;
        continue;
      }
      if (popularOnly && type === 'func' && !POPULAR_SITES.has(site)) {
        skipped++;
        continue;
      }
      // 'unknown' = cli() with neither pipeline nor func body. Not runnable.
      if (type === 'unknown') {
        skipped++;
        continue;
      }
      if (!isInstallable(src)) {
        skipped++;
        continue;
      }

      // Bundle only when there are relative imports — bare adapters ship raw
      // so the embedded source diffs cleanly against the opencli original.
      let source = src;
      const hasRelativeImports = /from\s+['"]\.\.?\//.test(src);
      if (hasRelativeImports) {
        try {
          source = await bundleAdapterSource(full);
        } catch (e) {
          console.warn(
            `  ⚠ ${site}/${file} bundle failed, shipping raw (will error at runtime): ${e.message}`,
          );
        }
      }

      // Write the per-adapter file under marketplace/<site>/<name>.js.
      const declaredSite = field(src, 'site') ?? site;
      const name = field(src, 'name') ?? basename(file, '.js');
      const sourceRel = `${declaredSite}/${name}.js`;
      if (!siteOutMade) {
        await mkdir(join(outDir, declaredSite), { recursive: true });
        siteOutMade = true;
      }
      await writeFile(join(outDir, sourceRel), source, 'utf8');
      written++;

      entries.push({
        site: declaredSite,
        name,
        description: field(src, 'description') ?? '',
        access: field(src, 'access') ?? 'read',
        domain: field(src, 'domain'),
        type,
        // Everything shipped from opencli is tier=official. Community-tier
        // adapters will land via the remote marketplace later, same schema,
        // just `tier: 'community'` + a different base URL.
        tier: 'official',
        author: 'opencli',
        // We don't track per-file versions upstream yet; bump manually when
        // breaking an adapter's API shape. The sha256 is the real upgrade
        // signal (changes whenever source changes).
        version: '1.0.0',
        source: sourceRel,
        sha256: sha256Hex(source),
      });
    }
  }

  entries.sort((a, b) => (a.site + a.name).localeCompare(b.site + b.name));

  // ISO date (not Date.now()) so the same source produces a stable enough
  // index for git diffs to focus on what actually changed — the timestamp
  // moving every build is unavoidable, but day-granularity would be nicer
  // long term (skipped for now to keep this simple).
  const bundledAt = new Date().toISOString();

  const index = {
    // Bump when changing the on-disk schema; clients should treat unknown
    // versions as "refuse to load" rather than parse-and-miss-fields.
    version: 2,
    bundledAt,
    generatedFrom: 'opencli/clis',
    includeAll,
    count: entries.length,
    adapters: entries,
  };

  await writeFile(join(outDir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  const indexBytes = JSON.stringify(index).length;
  console.log(`✓ ${outDir}/index.json + ${written} per-adapter .js files`);
  console.log(
    `  ${entries.length} adapters (${type_breakdown(entries)}) · scanned ${scanned} · skipped ${skipped} · index ${(indexBytes / 1024).toFixed(0)} KB`,
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
