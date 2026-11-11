import { getPermit } from '@/lib/permit';
import type { FakePermitClient } from '@/test/fake-permit';

/** The app's Permit client, which `vi.mock('permitio')` made a fake. */
export function fakePermit(): FakePermitClient {
  return getPermit() as unknown as FakePermitClient;
}
