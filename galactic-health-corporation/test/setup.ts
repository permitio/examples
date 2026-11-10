import { vi } from 'vitest';

// Every test file talks to the fake Permit client in test/permit-fake.ts instead of the real SDK.
vi.mock('permitio', async (original) => {
  const { withFakePermit } = await import('#test/permit-fake');
  return withFakePermit(await original<object>());
});
