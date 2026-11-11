import type {
  ConditionSetCreate,
  ConditionSetRuleCreate,
  ConditionSetUpdate,
  IListRoleAssignments,
  IPermitApi,
  IResource,
  IUser,
  ResourceCreate,
  ResourceUpdate,
  RoleAssignmentCreate,
  RoleAssignmentRead,
  RoleAssignmentRemove,
  RoleCreate,
  RoleUpdate,
  UserCreate,
  UserRead,
  UserUpdate,
} from 'permitio';
import { vi, type Mock } from 'vitest';

/**
 * A stand-in for the `Permit` client, the boundary every test mocks. A test file swaps it in with:
 *
 *     vi.mock('permitio', async (importOriginal) =>
 *       (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
 *     );
 *
 * The rest of the SDK, its error classes included, stays real.
 */

type ResourceInstanceCreate = Parameters<IPermitApi['resourceInstances']['create']>[0];
type RelationshipTupleCreate = Parameters<IPermitApi['relationshipTuples']['create']>[0];
type Write<A extends unknown[]> = Mock<(...args: A) => Promise<unknown>>;

export const fake = {
  check:
    vi.fn<
      (user: string | IUser, action: string, resource: string | IResource) => Promise<boolean>
    >(),
  config: { apiContext: { environmentContext: { projId: 'project-id', envId: 'environment-id' } } },
  api: {
    ensureAccessLevel: vi.fn<(level: string) => Promise<void>>(),
    resources: {
      create: vi.fn() as Write<[ResourceCreate]>,
      update: vi.fn() as Write<[string, ResourceUpdate]>,
    },
    roles: {
      create: vi.fn() as Write<[RoleCreate]>,
      update: vi.fn() as Write<[string, RoleUpdate]>,
    },
    conditionSets: {
      create: vi.fn() as Write<[ConditionSetCreate]>,
      update: vi.fn() as Write<[string, ConditionSetUpdate]>,
    },
    conditionSetRules: { create: vi.fn() as Write<[ConditionSetRuleCreate]> },
    users: {
      get: vi.fn<(key: string) => Promise<UserRead>>(),
      update: vi.fn() as Write<[string, UserUpdate]>,
      sync: vi.fn() as Write<[UserCreate]>,
    },
    resourceInstances: { create: vi.fn() as Write<[ResourceInstanceCreate]> },
    roleAssignments: {
      list: vi.fn<(params: IListRoleAssignments) => Promise<RoleAssignmentRead[]>>(),
      assign: vi.fn() as Write<[RoleAssignmentCreate]>,
      unassign: vi.fn() as Write<[RoleAssignmentRemove]>,
    },
    relationshipTuples: { create: vi.fn() as Write<[RelationshipTupleCreate]> },
  },
};

const writes: Write<never[]>[] = [
  fake.api.resources.create,
  fake.api.resources.update,
  fake.api.roles.create,
  fake.api.roles.update,
  fake.api.conditionSets.create,
  fake.api.conditionSets.update,
  fake.api.conditionSetRules.create,
  fake.api.users.update,
  fake.api.users.sync,
  fake.api.resourceInstances.create,
  fake.api.roleAssignments.assign,
  fake.api.roleAssignments.unassign,
  fake.api.relationshipTuples.create,
];

/** Replaces `Permit` in the real module with a constructor that returns {@link fake}. */
export function withFakePermit<T extends object>(actual: T): T {
  // A function, not an arrow: `new Permit()` needs a constructor, and returning an object from
  // one makes `new` return that object.
  return {
    ...actual,
    Permit: vi.fn(function FakePermit() {
      return fake;
    }),
  };
}

/** Forgets every call and answer: writes succeed, lists are empty, and every check is denied. */
export function resetFake(): void {
  fake.check.mockReset().mockResolvedValue(false);
  fake.api.ensureAccessLevel.mockReset().mockResolvedValue();
  fake.api.users.get.mockReset();
  fake.api.roleAssignments.list.mockReset().mockResolvedValue([]);
  for (const write of writes) write.mockReset().mockResolvedValue({});
}

const decisionId = (user: string | IUser, action: string, resource: string | IResource) =>
  JSON.stringify([typeof user === 'string' ? user : user.key, action, resource]);

/** Makes the PDP allow exactly these decisions and deny everything else. */
export function allow(
  ...decisions: [user: string, action: string, resource: string | IResource][]
) {
  const allowed = new Set(decisions.map((decision) => decisionId(...decision)));
  fake.check.mockImplementation(async (user, action, resource) =>
    allowed.has(decisionId(user, action, resource)),
  );
}

const TIMESTAMP = '2026-11-10T00:00:00Z';

export function userRead(
  email: string,
  name: string,
  attributes: Record<string, unknown> = {},
): UserRead {
  const [firstName = '', lastName = ''] = name.split(' ');
  return {
    key: email,
    id: `id-${email}`,
    organization_id: 'organization-id',
    project_id: 'project-id',
    environment_id: 'environment-id',
    email,
    first_name: firstName,
    last_name: lastName,
    attributes,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

export function assignment(
  user: string,
  role: string,
  resourceInstance?: string,
): RoleAssignmentRead {
  return {
    id: `${user} ${role} ${resourceInstance ?? ''}`,
    user,
    role,
    tenant: 'default',
    ...(resourceInstance === undefined ? {} : { resource_instance: resourceInstance }),
    user_id: `id-${user}`,
    role_id: `id-${role}`,
    tenant_id: 'tenant-id',
    organization_id: 'organization-id',
    project_id: 'project-id',
    environment_id: 'environment-id',
    created_at: TIMESTAMP,
  };
}

/** Answers `users.get` from this directory, and 404s like Permit for anyone else. */
export function directory(users: UserRead[], notFound: (key: string) => Error): void {
  const byKey = new Map(users.map((user) => [user.key, user]));
  fake.api.users.get.mockImplementation(async (key) => {
    const user = byKey.get(key);
    if (user === undefined) throw notFound(key);
    return user;
  });
}

/** Answers `roleAssignments.list` by filtering these assignments the way Permit does. */
export function assignments(all: RoleAssignmentRead[]): void {
  fake.api.roleAssignments.list.mockImplementation(async (params) =>
    all.filter(
      (a) =>
        (params.role === undefined || a.role === params.role) &&
        (params.user === undefined || a.user === params.user) &&
        (params.resourceInstance === undefined || a.resource_instance === params.resourceInstance),
    ),
  );
}
