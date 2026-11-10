import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['test/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    // Every vi.fn goes back to its default implementation before each test.
    mockReset: true,
    // Each test file gets its own in-memory database; Permit is replaced by test/permit-fake.ts.
    env: {
      DATABASE_PATH: ':memory:',
      BETTER_AUTH_SECRET: 'vitest-only-secret-vitest-only-secret',
      BETTER_AUTH_URL: 'http://localhost:3000',
      PERMIT_API_KEY: 'vitest-api-key',
      PERMIT_API_URL: 'http://permit.test',
      PERMIT_PDP_URL: 'http://pdp.test',
    },
  },
});
