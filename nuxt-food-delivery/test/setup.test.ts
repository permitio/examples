import { Permit } from 'permitio';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERSONAS, SEED_MEALS } from '#shared/demo';
import {
  CONDITION_SET_RULES,
  CONDITION_SETS,
  ORDER_ROLES,
  RESOURCES,
  TENANT_ROLES,
  TENANTS,
} from '#setup/policy';
import { runSetup, SetupError, setupClient, type SetupClient } from '#setup/setup';
import { apiError } from '#test/fakes';

vi.mock('permitio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permitio')>()),
  Permit: vi.fn(function Permit() {
    return { config: {} };
  }),
}));

/** The API methods setup calls, each resolving unless a test says otherwise. */
function fakeApi() {
  const ok = () => vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
  const pair = () => ({ create: ok(), update: ok() });
  return {
    resourceAttributes: pair(),
    resources: pair(),
    resourceRoles: pair(),
    roles: pair(),
    tenants: pair(),
    conditionSets: pair(),
    conditionSetRules: { create: ok() },
    users: { sync: ok() },
    roleAssignments: { assign: ok() },
    resourceInstances: { create: ok() },
  };
}

type FakeApi = ReturnType<typeof fakeApi>;
const asClient = (api: FakeApi) => ({ api }) as unknown as SetupClient;
const creates = (api: FakeApi) => [
  api.resourceAttributes.create,
  api.resources.create,
  api.resourceRoles.create,
  api.roles.create,
  api.tenants.create,
  api.conditionSets.create,
  api.conditionSetRules.create,
  api.users.sync,
  api.roleAssignments.assign,
  api.resourceInstances.create,
];

let api: FakeApi;
let lines: string[];
const log = (line: string) => lines.push(line);

beforeEach(() => {
  api = fakeApi();
  lines = [];
});

describe('runSetup on an empty environment', () => {
  beforeEach(() => runSetup(asClient(api), log));

  it('declares the number_of_rides user attribute', () => {
    expect(api.resourceAttributes.create).toHaveBeenCalledWith('__user', {
      key: 'number_of_rides',
      type: 'number',
      description: 'Deliveries the rider has made',
    });
  });

  it('creates Meal and Order, with the cost attribute and the free-delivery action', () => {
    expect(api.resources.create).toHaveBeenCalledTimes(2);
    expect(api.resources.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Order',
        actions: expect.objectContaining({ 'create-with-free-delivery': {}, 'assign-rider': {} }),
        attributes: { cost: { type: 'number', description: 'The order total before delivery' } },
      }),
    );
  });

  it('creates the Order#Vendor and Order#Rider instance roles', () => {
    expect(api.resourceRoles.create).toHaveBeenCalledWith('Order', {
      key: 'Vendor',
      name: 'Vendor',
      permissions: ['fulfill', 'read'],
    });
    expect(api.resourceRoles.create).toHaveBeenCalledWith('Order', {
      key: 'Rider',
      name: 'Rider',
      permissions: ['deliver', 'read'],
    });
  });

  it('creates the four tenant roles and the two city tenants', () => {
    expect(api.roles.create.mock.calls.map(([role]) => (role as { key: string }).key)).toEqual([
      'customer',
      'vendor',
      'rider',
      'admin',
    ]);
    expect(api.tenants.create).toHaveBeenCalledWith({ key: 'california', name: 'California' });
    expect(api.tenants.create).toHaveBeenCalledWith({ key: 'washington', name: 'Washington' });
  });

  it('creates the resource set for orders of 500 or more and the user set for 500+ rides', () => {
    expect(api.conditionSets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'orders_above_500',
        type: 'resourceset',
        resource_id: 'Order',
        conditions: { allOf: [{ allOf: [{ 'resource.cost': { 'greater-than-equals': 500 } }] }] },
      }),
    );
    expect(api.conditionSets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'experienced_riders',
        type: 'userset',
        conditions: {
          allOf: [{ allOf: [{ 'user.number_of_rides': { 'greater-than-equals': 500 } }] }],
        },
      }),
    );
  });

  it('grants the ABAC rules, with is_role for the role-based ones', () => {
    expect(api.conditionSetRules.create).toHaveBeenCalledWith({
      user_set: 'customer',
      is_role: true,
      permission: 'Order:create-with-free-delivery',
      resource_set: 'orders_above_500',
    });
    expect(api.conditionSetRules.create).toHaveBeenCalledWith({
      user_set: 'experienced_riders',
      permission: 'Order:deliver',
      resource_set: 'orders_above_500',
    });
  });

  it('creates every persona with its rides and its roles in each city', () => {
    expect(api.users.sync).toHaveBeenCalledTimes(PERSONAS.length);
    expect(api.users.sync).toHaveBeenCalledWith({
      key: 'rider2',
      attributes: { number_of_rides: 650 },
    });
    expect(api.users.sync).toHaveBeenCalledWith({ key: 'customer1', attributes: {} });
    expect(api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'admin1',
      role: 'admin',
      tenant: 'washington',
    });
    expect(api.roleAssignments.assign).toHaveBeenCalledTimes(
      PERSONAS.flatMap((persona) => persona.roles).length,
    );
  });

  it('registers each demo meal as a Meal instance in its city', () => {
    expect(api.resourceInstances.create).toHaveBeenCalledTimes(SEED_MEALS.length);
    expect(api.resourceInstances.create).toHaveBeenCalledWith({
      key: 'clam-chowder',
      resource: 'Meal',
      tenant: 'washington',
    });
  });

  it('logs one line per object, saying what it did', () => {
    expect(lines).toContain('  created  resource Order');
    expect(lines).toContain('  synced   user rider2');
    expect(lines).toContain('  assigned role admin for admin1 in washington');
    expect(lines.filter((line) => line.startsWith('  '))).toHaveLength(
      creates(api).reduce((sum, create) => sum + create.mock.calls.length, 0),
    );
  });
});

describe('runSetup on an environment that has everything (a re-run)', () => {
  beforeEach(async () => {
    for (const create of creates(api)) create.mockRejectedValue(apiError(409));
    await runSetup(asClient(api), log);
  });

  it('updates each role to its permissions', () => {
    const admin = TENANT_ROLES.find((role) => role.key === 'admin');
    expect(api.roles.update).toHaveBeenCalledWith('admin', {
      name: 'Admin',
      permissions: admin?.permissions,
    });
  });

  it('updates resources, instance roles, tenants, condition sets and the attribute', () => {
    expect(api.resources.update).toHaveBeenCalledWith(
      'Meal',
      expect.objectContaining({ name: 'Meal', actions: expect.any(Object) }),
    );
    expect(api.resourceRoles.update).toHaveBeenCalledWith('Order', 'Rider', {
      name: 'Rider',
      permissions: ['deliver', 'read'],
    });
    expect(api.tenants.update).toHaveBeenCalledWith('washington', { name: 'Washington' });
    expect(api.conditionSets.update).toHaveBeenCalledWith(
      'experienced_riders',
      expect.objectContaining({ conditions: expect.any(Object) }),
    );
    expect(api.resourceAttributes.update).toHaveBeenCalledWith('__user', 'number_of_rides', {
      type: 'number',
      description: 'Deliveries the rider has made',
    });
  });

  it('reports what existed and what it updated', () => {
    expect(lines).toContain('  updated  role admin');
    expect(lines).toContain('  exists   role admin for admin1 in california');
    expect(lines).toContain('  exists   meal miso-soup in california');
  });
});

describe('runSetup when Permit refuses', () => {
  it("stops at the first error, naming the object and keeping Permit's explanation", async () => {
    api.roles.create.mockRejectedValue(apiError(422));

    const run = runSetup(asClient(api), log);

    await expect(run).rejects.toBeInstanceOf(SetupError);
    await expect(run).rejects.toThrow(
      'role customer: Request failed with status code 422 {"message":"from Permit"}',
    );
    expect(api.tenants.create).not.toHaveBeenCalled();
  });

  it('fails when an update after a 409 fails', async () => {
    api.tenants.create.mockRejectedValue(apiError(409));
    api.tenants.update.mockRejectedValue(apiError(403));

    await expect(runSetup(asClient(api), log)).rejects.toThrow('tenant california: ');
  });

  it('fails on a network error', async () => {
    api.resourceAttributes.create.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.test'));

    await expect(runSetup(asClient(api), log)).rejects.toThrow(
      'user attribute number_of_rides: getaddrinfo ENOTFOUND api.test',
    );
  });
});

describe('setupClient', () => {
  beforeEach(() => vi.mocked(Permit).mockClear());

  it('writes to PERMIT_API_URL with the SDK log off', () => {
    setupClient({
      PERMIT_API_KEY: 'test-api-key',
      PERMIT_API_URL: 'http://host.docker.internal:8000',
    });

    expect(Permit).toHaveBeenCalledWith({
      token: 'test-api-key',
      apiUrl: 'http://host.docker.internal:8000',
      log: { level: 'silent' },
    });
  });

  it("defaults to Permit's cloud API", () => {
    setupClient({ PERMIT_API_KEY: 'test-api-key', PERMIT_API_URL: '' });

    expect(Permit).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://api.permit.io' }),
    );
  });

  it('fails with a pointer to .env when there is no key', () => {
    expect(() => setupClient({})).toThrow('PERMIT_API_KEY is not set.');
  });
});

describe('the policy', () => {
  const actionsOf = (key: string) =>
    Object.keys(RESOURCES.find((resource) => resource.key === key)?.actions ?? {});
  const permissions = RESOURCES.flatMap((resource) =>
    actionsOf(resource.key).map((action) => `${resource.key}:${action}`),
  );

  it('grants roles only actions the resources declare', () => {
    for (const role of TENANT_ROLES) {
      for (const permission of role.permissions) expect(permissions).toContain(permission);
    }
    for (const role of ORDER_ROLES) {
      for (const action of role.permissions ?? []) expect(actionsOf('Order')).toContain(action);
    }
  });

  it('gives fulfill and deliver to no tenant role but admin, so the order decides', () => {
    const holders = (permission: string) =>
      TENANT_ROLES.filter((role) => role.permissions.includes(permission as never)).map(
        (role) => role.key,
      );
    expect(holders('Order:fulfill')).toEqual(['admin']);
    expect(holders('Order:deliver')).toEqual(['admin']);
  });

  it('builds rules from roles and sets it declares, on actions that exist', () => {
    const roleKeys = TENANT_ROLES.map((role) => role.key as string);
    const setKeys = CONDITION_SETS.map((set) => set.key);
    for (const rule of CONDITION_SET_RULES) {
      expect(rule.is_role ? roleKeys : setKeys).toContain(rule.user_set);
      expect(setKeys).toContain(rule.resource_set);
      expect(permissions).toContain(rule.permission);
    }
  });

  it('declares a tenant for every city a persona or a meal uses', () => {
    const tenants = TENANTS.map((tenant) => tenant.key);
    for (const { tenant } of PERSONAS.flatMap((persona) => persona.roles)) {
      expect(tenants).toContain(tenant);
    }
    for (const meal of SEED_MEALS) expect(tenants).toContain(meal.city);
  });
});
