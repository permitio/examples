import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'apps/portal/src/web') } },
  test: { include: ['apps/*/test/**/*.test.ts'], environment: 'node' },
});
