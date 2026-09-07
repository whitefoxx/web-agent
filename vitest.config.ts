import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Mirror the opencli compat aliases from vite.config.ts so tests can import
// unmodified opencli-style adapters (which reference '@jackwener/opencli/*')
// and have them resolve to our browser-safe shims.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
  // Mirror vite.config.ts's build-time flags (src/build-flags.d.ts). Tests run
  // the SHIPPED shape, so the dev flag is false; without the define, importing a
  // module that reads it would throw ReferenceError instead of taking a branch.
  define: {
    __WEBCLI_DEV__: 'false',
    __LOCALMD_DEV__: 'false',
  },
  resolve: {
    alias: {
      '@base': resolve(__dirname, 'web-tools/src'),
      '@jackwener/opencli/registry': resolve(__dirname, 'web-tools/src/runtime/registry.js'),
      '@jackwener/opencli/errors': resolve(__dirname, 'web-tools/src/runtime/errors.js'),
      '@jackwener/opencli/utils': resolve(__dirname, 'src/runtime/opencli/utils.ts'),
      '@jackwener/opencli/logger': resolve(__dirname, 'src/runtime/opencli/logger.ts'),
      '@jackwener/opencli/types': resolve(__dirname, 'src/runtime/opencli/types.ts'),
      '@jackwener/opencli/pipeline': resolve(__dirname, 'src/runtime/opencli/pipeline.ts'),
    },
  },
});
