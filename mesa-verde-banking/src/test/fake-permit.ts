import type { Permit } from 'permitio';
import { vi } from 'vitest';

/**
 * A stand-in for the permitio SDK's `Permit` client, with a mock for each method the app calls.
 * Test files install it with:
 *
 *     vi.mock('permitio', async (original) => ({
 *       ...(await original<typeof import('permitio')>()),
 *       Permit: (await import('@/test/fake-permit')).FakePermit,
 *     }));
 *
 * It must not import the app's modules: the mock factory loads it while `permitio` loads.
 */
export function createFakePermit() {
  return {
    check: vi.fn<Permit['check']>(),
    bulkCheck: vi.fn<Permit['bulkCheck']>(),
    getUserPermissions: vi.fn<Permit['getUserPermissions']>(),
    config: { apiContext: { environment: 'env-id-from-key' as string | null } },
    elements: { loginAs: vi.fn<Permit['elements']['loginAs']>() },
    api: {
      ensureAccessLevel: vi.fn<Permit['api']['ensureAccessLevel']>(),
      tenants: {
        create: vi.fn<Permit['api']['tenants']['create']>(),
        get: vi.fn<Permit['api']['tenants']['get']>(),
        list: vi.fn<Permit['api']['tenants']['list']>(),
        listTenantUsers: vi.fn<Permit['api']['tenants']['listTenantUsers']>(),
      },
      users: {
        get: vi.fn<Permit['api']['users']['get']>(),
        getById: vi.fn<Permit['api']['users']['getById']>(),
        sync: vi.fn<Permit['api']['users']['sync']>(),
      },
      roleAssignments: { assign: vi.fn<Permit['api']['roleAssignments']['assign']>() },
      resourceInstances: {
        create: vi.fn<Permit['api']['resourceInstances']['create']>(),
        getById: vi.fn<Permit['api']['resourceInstances']['getById']>(),
        delete: vi.fn<Permit['api']['resourceInstances']['delete']>(),
      },
    },
  };
}

export type FakePermitClient = ReturnType<typeof createFakePermit>;

/** A constructor that hands out a fake client, for `vi.mock('permitio')`. */
export const FakePermit = vi.fn(function FakePermit() {
  return createFakePermit();
});

/** An error shaped like the SDK's PermitApiError for an HTTP status. */
export function permitApiError(status: number): Error {
  return Object.assign(new Error(`Got error status code: ${status}`), { response: { status } });
}
