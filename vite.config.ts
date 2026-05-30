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
const USERSCRIPT_RUNNER = 'userscript-runner.js';

function sandboxPagePlugin(): Plugin {
  const SANDBOX_HTML = 'sandbox.html';
  return {
    name: 'webchat-sandbox-page',
    apply: 'build',
    async writeBundle(_opts, bundle) {
      // 1. Write the REAL self-contained sandbox page, overwriting whatever
      //    @crxjs emitted for the "sandbox.html" placeholder.
      const result = await esbuild({
        entryPoints: [resolve(__dirname, 'src/sandbox/eval-host.ts')],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        write: false,
        legalComments: 'none',
      });
      const code = result.outputFiles[0].text;
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
      await writeFile(resolve(__dirname, 'dist', SANDBOX_HTML), html, 'utf8');

      // 2. Copy the real marketplace index to dist (overwriting the placeholder).
      const indexSrc = resolve(__dirname, 'marketplace/index.json');
      if (existsSync(indexSrc)) {
        await writeFile(
          resolve(__dirname, 'dist', MARKET_INDEX),
          await readFile(indexSrc, 'utf8'),
          'utf8',
        );
      }

      // 3. Bundle the USER_SCRIPT-world runner into a self-contained IIFE,
      //    same constraint as the sandbox host (no module loader, no chrome.*
      //    bundler tricks). chrome.userScripts.execute({js:[{file:...}]}) loads
      //    it into the target tab's runner world — declared as a WAR so the
      //    extension URL is fetchable from the page context.
      const runnerBuild = await esbuild({
        entryPoints: [resolve(__dirname, 'src/userscript/runner.ts')],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        write: false,
        legalComments: 'none',
      });
      await writeFile(
        resolve(__dirname, 'dist', USERSCRIPT_RUNNER),
        runnerBuild.outputFiles[0].text,
        'utf8',
      );

      // 4. Patch sandbox.pages into the built manifest.
      const manifestPath = resolve(__dirname, 'dist', 'manifest.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.sandbox = { pages: [SANDBOX_HTML] };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }
      void bundle;
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
