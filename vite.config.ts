import { defineConfig, type Plugin } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import fullManifest from './manifest.json';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';

// This repo builds ONE extension: the full "Web Agent" (agent + adapters +
// SidePanel + explore). The shared base it stands on — the generic tools,
// the runtime, site scripts, the lean service workers — lives in the
// `web-tools/` git submodule (the open repo, which also builds WebCLI and
// localmd Connect). Full-shell code reaches it through the `@base/*` alias
// below; the two lean shells are built from web-tools itself, not from here.
// See docs/architecture.md §A.
const BASE_SRC = resolve(__dirname, 'web-tools/src');

// Aliases so UNMODIFIED opencli adapters can `import { ... } from
// '@jackwener/opencli/<subpath>'` and resolve to our local browser-safe shims
// — the basis of source-level adapter compatibility (no import rewriting).
// Keep this list in sync with tsconfig.json "paths" (tsc uses that, Vite uses
// these). Source of truth for the subpath set: opencli package.json "exports".
// registry/errors moved to the base with the tool runtime; the pipeline shims
// are adapter machinery and stay here.
const opencliAliases = {
  '@jackwener/opencli/registry': resolve(BASE_SRC, 'runtime/registry.js'),
  '@jackwener/opencli/errors': resolve(BASE_SRC, 'runtime/errors.js'),
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
const USERSCRIPT_RUNNER = 'userscript-runner.js';

function sandboxPagePlugin(outDir: string): Plugin {
  const SANDBOX_HTML = 'sandbox.html';
  return {
    name: 'web-sandbox-page',
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
    <title>Web Agent — adapter sandbox</title>
  </head>
  <body>
    <script>${code}</script>
  </body>
</html>
`;
      await writeFile(resolve(__dirname, outDir, SANDBOX_HTML), html, 'utf8');

      // 2. (Removed) Marketplace adapters are no longer bundled — they live in
      //    the separate public repo (a git submodule at marketplace/) and the
      //    extension fetches index.json + per-adapter source from GitHub raw on
      //    demand (sha256-verified). Keeps the shipped bundle ~2.7 MB smaller and
      //    lets adapters update without an extension release. See
      //    docs/adapter-hot-plug.md + web-tools/src/core/marketplace.ts.

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
        resolve(__dirname, outDir, USERSCRIPT_RUNNER),
        runnerBuild.outputFiles[0].text,
        'utf8',
      );

      // 3b. Offscreen document (the panel-free eval venue). It's a NORMAL
      //     extension page (needs chrome.* to relay), so unlike sandbox.html the
      //     script can't be inlined (extension_pages CSP = script-src 'self') —
      //     emit it as an external 'self' file and reference it from the HTML.
      const offscreenBuild = await esbuild({
        entryPoints: [resolve(__dirname, 'src/offscreen/offscreen.ts')],
        bundle: true,
        format: 'iife',
        target: 'esnext',
        write: false,
        legalComments: 'none',
      });
      await writeFile(
        resolve(__dirname, outDir, 'offscreen.js'),
        offscreenBuild.outputFiles[0].text,
        'utf8',
      );
      await writeFile(
        resolve(__dirname, outDir, 'offscreen.html'),
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Web Agent — offscreen</title>
  </head>
  <body>
    <script src="offscreen.js"></script>
  </body>
</html>
`,
        'utf8',
      );

      // 4. Patch sandbox.pages into the built manifest.
      const manifestPath = resolve(__dirname, outDir, 'manifest.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.sandbox = { pages: [SANDBOX_HTML] };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }
      void bundle;
    },
  };
}

const OUT_DIR = 'dist';

export default defineConfig({
  plugins: [
    preact(),
    // @ts-expect-error -- crxjs manifest typing is looser than our JSON
    crx({ manifest: fullManifest }),
    sandboxPagePlugin(OUT_DIR),
  ],
  resolve: {
    alias: {
      ...opencliAliases,
      // The shared base, mounted as a submodule. tsconfig.json "paths" mirrors it.
      '@base': BASE_SRC,
    },
  },
  define: {
    // Build-time flags the base declares (web-tools/src/build-flags.d.ts, mirrored
    // by src/build-flags.d.ts here). The full extension is never a dev-identity
    // lean shell, so both are a literal `false`; vitest.config.ts mirrors them.
    __WEBCLI_DEV__: 'false',
    __LOCALMD_DEV__: 'false',
  },
  build: {
    target: 'esnext',
    minify: false,
    outDir: OUT_DIR,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
