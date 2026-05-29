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
  resolve: {
    alias: {
      '@jackwener/opencli/registry': resolve(__dirname, 'src/runtime/registry.js'),
      '@jackwener/opencli/errors': resolve(__dirname, 'src/runtime/errors.js'),
      '@jackwener/opencli/utils': resolve(__dirname, 'src/runtime/opencli/utils.ts'),
      '@jackwener/opencli/logger': resolve(__dirname, 'src/runtime/opencli/logger.ts'),
      '@jackwener/opencli/types': resolve(__dirname, 'src/runtime/opencli/types.ts'),
      '@jackwener/opencli/pipeline': resolve(__dirname, 'src/runtime/opencli/pipeline.ts'),
    },
  },
});
