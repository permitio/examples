import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The root tsconfig.json only points at the tsconfigs `nuxt prepare` generates in .nuxt/, which a
  // fresh checkout does not have. The tests compile with the scripts' tsconfig instead.
  tsconfig: 'tsconfig.scripts.json',
  // `~/` is Nuxt's alias for app/; the tests use it for the app's plain TypeScript helpers.
  resolve: { alias: { '~': resolve(import.meta.dirname, 'app') } },
  test: { include: ['test/**/*.test.ts', 'tools/**/*.test.ts'], environment: 'node' },
});
