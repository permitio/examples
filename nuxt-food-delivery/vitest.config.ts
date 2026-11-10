import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `~/` is Nuxt's alias for app/; the tests use it for the app's plain TypeScript helpers.
  resolve: { alias: { '~': resolve(import.meta.dirname, 'app') } },
  test: { include: ['test/**/*.test.ts', 'tools/**/*.test.ts'], environment: 'node' },
});
