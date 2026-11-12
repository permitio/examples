/**
 * A stand-in for the Permit SDK client, the one boundary the tests mock. Each test file replaces
 * the `permitio` module with:
 *
 *     vi.mock('permitio', async (original) => withFakePermit(await original()));
 *
 * Every method is a `vi.fn`; vitest's `mockReset` restores the defaults below before each test.
 */
import type { UserRead } from 'permitio';
import { vi } from 'vitest';

/** An error shaped like the SDK's `PermitApiError` for an API answer with this status. */
export function permitApiError(status: number, message = `Permit answered ${status}`): Error {
  return Object.assign(new Error(message), { response: { status, data: { message } } });
}

/** A Permit user as `api.users.get` returns it. */
export function permitUser(key: string, fields: Partial<UserRead> = {}): UserRead {
  return {
    key,
    id: `id-${key}`,
    organization_id: 'org',
    project_id: 'project',
    environment_id: 'env',
    email: `${key}@example.com`,
    first_name: key,
    last_name: 'Tester',
    attributes: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...fields,
  };
}

/** A role assignment as `api.roleAssignments.list` returns it. */
export function assignment(user: string, role: string, resourceInstance?: string) {
  return {
    id: `${user}-${role}-${resourceInstance ?? 'tenant'}`,
    user,
    role,
    tenant: 'default',
    ...(resourceInstance === undefined ? {} : { resource_instance: resourceInstance }),
    user_id: `id-${user}`,
    role_id: role,
    tenant_id: 'default',
    organization_id: 'org',
    project_id: 'project',
    environment_id: 'env',
    created_at: '2026-01-01T00:00:00Z',
  };
}

const ok = async (..._args: unknown[]): Promise<unknown> => ({});

/** Answers 404 until a test says otherwise. */
function missing<T>() {
  return async (..._args: unknown[]): Promise<T> => {
    throw permitApiError(404);
  };
}

interface Instance {
  key: string;
  resource: string;
  attributes?: object;
}

export const permitFake = {
  check: vi.fn(async (..._args: unknown[]) => true),
  bulkCheck: vi.fn(async (checks: unknown[]) => checks.map(() => true)),
  api: {
    users: {
      get: vi.fn(missing<UserRead>()),
      list: vi.fn(async (..._args: unknown[]) => ({ data: [] as UserRead[] })),
      sync: vi.fn(ok),
      update: vi.fn(ok),
    },
    roleAssignments: {
      assign: vi.fn(ok),
      unassign: vi.fn(ok),
      list: vi.fn(async (..._args: unknown[]) => [] as ReturnType<typeof assignment>[]),
    },
    relationshipTuples: { create: vi.fn(ok), delete: vi.fn(ok) },
    resourceInstances: { create: vi.fn(ok), get: vi.fn(missing<Instance>()), delete: vi.fn(ok) },
    resources: { create: vi.fn(ok), update: vi.fn(ok) },
    resourceRelations: { create: vi.fn(ok) },
    resourceRoles: { create: vi.fn(ok), update: vi.fn(ok) },
    roles: { create: vi.fn(ok), update: vi.fn(ok) },
  },
};

/** The `permitio` module with `Permit` replaced by a class whose instances are `permitFake`. */
export function withFakePermit<T extends object>(actual: T): T {
  class Permit {
    constructor() {
      // oxlint-disable-next-line no-constructor-return -- every client the app makes is the fake
      return permitFake;
    }
  }
  return { ...actual, Permit };
}
