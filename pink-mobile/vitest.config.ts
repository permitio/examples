import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    // The SDK is mocked in every test that reaches it; these only satisfy lib/permit.ts.
    env: {
      PERMIT_API_KEY: 'test-api-key',
      PERMIT_API_URL: 'http://permit.test',
      PERMIT_PDP_URL: 'http://pdp.test',
    },
  },
});
