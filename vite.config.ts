import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import manifest from './manifest.json';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';

// Aliases so UNMODIFIED opencli adapters can `import { ... } from
// '@jackwener/opencli/<subpath>'` and resolve to our local browser-safe shims
// — the basis of source-level adapter compatibility (no import rewriting).
// Keep this list in sync with tsconfig.json "paths" (tsc uses that, Vite uses
// these). Source of truth for the subpath set: opencli package.json "exports".
const opencliAliases = {
  '@jackwener/opencli/registry': resolve(__dirname, 'src/runtime/registry.js'),
  '@jackwener/opencli/errors': resolve(__dirname, 'src/runtime/errors.js'),
  '@jackwener/opencli/utils': resolve(__dirname, 'src/runtime/opencli/utils.ts'),
  '@jackwener/opencli/logger': resolve(__dirname, 'src/runtime/opencli/logger.ts'),
  '@jackwener/opencli/types': resolve(__dirname, 'src/runtime/opencli/types.ts'),
  '@jackwener/opencli/pipeline': resolve(__dirname, 'src/runtime/opencli/pipeline.ts'),
};

/**
 * Emit the MV3 sandboxed page ourselves instead of letting @crxjs process it.
 *
 * Why: @crxjs wraps every HTML page's script in a "crx loader" that does
 * `import(chrome.runtime.getURL(...))`. Sandboxed pages have NO `chrome.*`, so
 * that loader throws — and @crxjs additionally leaves an unresolved filename
 * placeholder in the sandbox HTML. (Verified empirically: it doesn't support
 * sandbox pages.) So we own the artifact: esbuild-bundle the eval host into a
 * single self-contained IIFE, INLINE it into sandbox.html (no external module,
 * no chrome.* loader), and register the page in the built manifest. Inlining
 * sidesteps every path/loader pitfall.
 */
const MARKET_INDEX = 'marketplace-index.json';

function sandboxPagePlugin(): Plugin {
  const SANDBOX_HTML = 'sandbox.html';
  let outDir = resolve(__dirname, 'dist');
  return {
    name: 'webchat-sandbox-page',
    apply: 'build',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    // closeBundle runs AFTER every plugin's writeBundle (including @crxjs's
    // manifest emit), so our manifest patch survives.
    async closeBundle() {
      // 1. Bundle the eval host (pure, dependency-free) to one IIFE string.
      const result = await esbuild({
        entryPoints: [resolve(__dirname, 'src/sandbox/eval-host.ts')],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        write: false,
        legalComments: 'none',
      });
      const code = result.outputFiles[0].text;

      // 2. Write a self-contained sandbox page (classic inline script — no
      //    module, no chrome.*, no external fetch).
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>WebChat Agent — adapter sandbox</title>
  </head>
  <body>
    <script>${code}</script>
  </body>
</html>
`;
      await writeFile(resolve(outDir, SANDBOX_HTML), html, 'utf8');

      // 3. Bundle the marketplace index (if generated) as a web-accessible
      //    resource so the SidePanel can browse a default catalog out of the
      //    box (chrome.runtime.getURL). A remote index URL set in settings
      //    overrides this — that's how the catalog updates without a rebuild.
      const indexSrc = resolve(__dirname, 'marketplace/index.json');
      let bundledIndex = false;
      if (existsSync(indexSrc)) {
        await writeFile(resolve(outDir, MARKET_INDEX), await readFile(indexSrc, 'utf8'), 'utf8');
        bundledIndex = true;
      }

      // 4. Register the page + resources in the built manifest.
      const manifestPath = resolve(outDir, 'manifest.json');
      const builtManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      builtManifest.sandbox = { pages: [SANDBOX_HTML] };
      const resources = [SANDBOX_HTML];
      if (bundledIndex) resources.push(MARKET_INDEX);
      const war = builtManifest.web_accessible_resources ?? [];
      war.push({ resources, matches: ['<all_urls>'] });
      builtManifest.web_accessible_resources = war;
      await writeFile(manifestPath, JSON.stringify(builtManifest, null, 2), 'utf8');
    },
  };
}

// @ts-expect-error -- crxjs manifest typing is looser than our JSON
export default defineConfig({
  plugins: [preact(), crx({ manifest }), sandboxPagePlugin()],
  resolve: {
    alias: opencliAliases,
  },
  build: {
    target: 'esnext',
    minify: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
