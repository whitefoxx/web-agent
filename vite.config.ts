import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import preact from '@preact/preset-vite';
import manifest from './manifest.json';
import { resolve } from 'node:path';

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
};

// @ts-expect-error -- crxjs manifest typing is looser than our JSON
export default defineConfig({
  plugins: [preact(), crx({ manifest })],
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
