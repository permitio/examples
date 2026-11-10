import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeError } from '#lib/errors';
import { resources, roleAssignments, users } from '#lib/policy';
import { runSetup } from '#lib/setup';
import { assignment, assignments, fake, resetFake } from '#test/fake-permit';
import { apiError } from '#test/permit-errors';

vi.mock('permitio', async (importOriginal) =>
  (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
);

const fetchMock = vi.fn<typeof fetch>();
let log: string[] = [];
const run = () => runSetup((line) => log.push(line));

beforeEach(() => {
  resetFake();
  log = [];
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runSetup in an empty environment', () => {
  it('creates the user attribute through the REST API of PERMIT_API_URL', async () => {
    await run();

    expect(fake.api.ensureAccessLevel).toHaveBeenCalledWith('ENVIRONMENT_LEVEL_API_KEY');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://permit.test/v2/schema/project-id/environment-id/users/attributes',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'blocked',
          type: 'bool',
          description: 'A blocked customer may view their plan only',
        }),
      },
    );
    expect(log).toContain('created user attribute blocked');
  });

  it('creates the resources one by one, account before the plan that refers to it', async () => {
    await run();

    const created = fake.api.resources.create.mock.calls.map(([resource]) => resource.key);
    expect(created).toEqual(['representatives', 'users', 'account', 'plan']);
    expect(fake.api.resources.create).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'plan',
        relations: { parent: 'account' },
        roles: {
          editor: expect.objectContaining({
            granted_to: {
              users_with_role: [
                { role: 'editor', on_resource: 'account', linked_by_relation: 'parent' },
              ],
            },
          }),
        },
      }),
    );
    expect(fake.api.resources.update).not.toHaveBeenCalled();
  });

  it('creates the roles, condition sets and rules', async () => {
    await run();

    expect(fake.api.roles.create.mock.calls.map(([role]) => role.key).toSorted()).toEqual([
      'manager',
      'representative',
    ]);
    expect(fake.api.conditionSets.create.mock.calls.map(([set]) => set.key).toSorted()).toEqual([
      'active_users',
      'blocked_users',
      'owned_plans',
    ]);
    expect(fake.api.conditionSetRules.create).toHaveBeenCalledWith({
      user_set: 'blocked_users',
      resource_set: 'owned_plans',
      permission: 'plan:view',
    });
    expect(fake.api.conditionSetRules.create).toHaveBeenCalledTimes(3);
  });

  it('syncs the users, creates the instances, assigns roles and relates plans', async () => {
    await run();

    expect(fake.api.users.sync).toHaveBeenCalledTimes(6);
    expect(fake.api.users.sync).toHaveBeenCalledWith({
      key: 'ron@weasley.me',
      email: 'ron@weasley.me',
      first_name: 'Ron',
      last_name: 'Weasley',
      attributes: { plan: 'Standard', blocked: true },
    });
    expect(fake.api.resourceInstances.create).toHaveBeenCalledWith({
      resource: 'plan',
      key: 'hermione',
      tenant: 'default',
    });
    expect(fake.api.roleAssignments.assign).toHaveBeenCalledTimes(roleAssignments.length);
    expect(fake.api.relationshipTuples.create).toHaveBeenCalledWith({
      subject: 'account:harry',
      relation: 'parent',
      object: 'plan:harry',
      tenant: 'default',
    });
    expect(fake.api.roleAssignments.unassign).not.toHaveBeenCalled();
  });
});

describe('runSetup in an environment it already set up', () => {
  beforeEach(() => {
    const conflict = () => Promise.reject(apiError(409));
    fake.api.resources.create.mockImplementation(conflict);
    fake.api.roles.create.mockImplementation(conflict);
    fake.api.conditionSets.create.mockImplementation(conflict);
    fake.api.conditionSetRules.create.mockImplementation(conflict);
    fake.api.resourceInstances.create.mockImplementation(conflict);
    fetchMock.mockResolvedValue(new Response('{}', { status: 409 }));
  });

  it('updates resources, roles and condition sets to match lib/policy.ts', async () => {
    await run();

    const plan = resources.find((resource) => resource.key === 'plan');
    const { key: _key, ...planWithoutKey } = plan ?? { key: '' };
    expect(fake.api.resources.update).toHaveBeenCalledWith('plan', planWithoutKey);
    expect(fake.api.roles.update).toHaveBeenCalledWith('representative', {
      name: 'Representative',
      permissions: ['users:list'],
    });
    expect(fake.api.conditionSets.update).toHaveBeenCalledWith('active_users', {
      name: 'Active Users',
      conditions: { allOf: [{ allOf: [{ 'user.blocked': { equals: false } }] }] },
    });
    expect(log).toEqual(
      expect.arrayContaining([
        'kept user attribute blocked',
        'updated resource plan',
        'kept rule active_users plan:change owned_plans',
        'kept account:ron',
      ]),
    );
  });

  it('removes role assignments the demo added and keeps the starting ones', async () => {
    assignments([
      assignment('sirius@pink.mobile', 'representative'),
      assignment('sirius@pink.mobile', 'editor', 'account:harry'),
      assignment('sirius@pink.mobile', 'editor', 'account:ron'),
      assignment('hermione@granger.app', 'owner', 'account:hermione'),
    ]);

    await run();

    expect(fake.api.roleAssignments.unassign).toHaveBeenCalledTimes(2);
    expect(fake.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: 'sirius@pink.mobile',
      role: 'editor',
      resource_instance: 'account:ron',
      tenant: 'default',
    });
    expect(fake.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: 'hermione@granger.app',
      role: 'owner',
      resource_instance: 'account:hermione',
      tenant: 'default',
    });
    expect(fake.api.roleAssignments.list).toHaveBeenCalledTimes(users.length);
  });
});

describe('runSetup failures', () => {
  it('stops at the first failing call and names it, with what Permit answered', async () => {
    fake.api.resources.create.mockRejectedValue(apiError(422, { message: 'bad action key' }));

    const failure = await run().catch((error: unknown) => error);

    expect(describeError(failure)).toBe(
      'Could not create resource representatives\n' +
        '  caused by: Request failed with status code 422 (HTTP 422) {"message":"bad action key"}',
    );
    expect(fake.api.roles.create).not.toHaveBeenCalled();
  });

  it('names the update when the update after a 409 fails', async () => {
    fake.api.roles.create.mockRejectedValue(apiError(409));
    fake.api.roles.update.mockRejectedValue(apiError(400));

    await expect(run()).rejects.toThrow(/^Could not update role (manager|representative)$/);
  });

  it('reports what the REST API answered when the user attribute fails', async () => {
    fetchMock.mockResolvedValue(new Response('{"detail":"forbidden"}', { status: 403 }));

    await expect(run()).rejects.toThrow(
      'Could not create user attribute blocked: 403 {"detail":"forbidden"}',
    );
    expect(fake.api.resources.create).not.toHaveBeenCalled();
  });

  it('points at PERMIT_API_URL and the key when the key scope cannot be read', async () => {
    fake.api.ensureAccessLevel.mockRejectedValue(new Error('could not fetch the api key scope'));

    await expect(run()).rejects.toThrow(
      "Could not read the API key's environment from http://permit.test " +
        '(are PERMIT_API_URL and the key right?)',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the user attribute when the REST API cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const failure = await run().catch((error: unknown) => error);

    expect(describeError(failure)).toBe(
      'Could not create user attribute blocked\n  caused by: fetch failed',
    );
  });

  it('names the user whose sync failed', async () => {
    fake.api.users.sync.mockRejectedValue(apiError(422));

    await expect(run()).rejects.toThrow(/^Could not sync user /);
    expect(fake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('stops before assigning when the current assignments cannot be read', async () => {
    fake.api.roleAssignments.list.mockRejectedValue(apiError(500));

    await expect(run()).rejects.toThrow(/^Could not list the role assignments of /);
    expect(fake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('names the assignment that failed', async () => {
    fake.api.roleAssignments.assign.mockImplementation(async (body) => {
      if (body.user === 'luna@pink.mobile' && body.role === 'editor') throw apiError(404);
      return {};
    });

    await expect(run()).rejects.toThrow(
      'Could not write role editor on account:ron for luna@pink.mobile',
    );
  });
});

describe('runSetup role assignments and tuples', () => {
  it('writes them one at a time, so Permit never sees two at once', async () => {
    let inFlight = 0;
    let most = 0;
    const oneAtATime = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return {};
    };
    fake.api.roleAssignments.assign.mockImplementation(oneAtATime);
    fake.api.relationshipTuples.create.mockImplementation(oneAtATime);
    fake.api.roleAssignments.unassign.mockImplementation(oneAtATime);
    assignments([
      assignment('sirius@pink.mobile', 'editor', 'account:ron'),
      assignment('luna@pink.mobile', 'editor', 'account:harry'),
    ]);

    await run();

    expect(fake.api.roleAssignments.unassign).toHaveBeenCalledTimes(2);
    expect(fake.api.roleAssignments.assign).toHaveBeenCalledTimes(roleAssignments.length);
    expect(most).toBe(1);
  });

  it('keeps an assignment or a tuple that Permit answers 409 for', async () => {
    fake.api.roleAssignments.assign.mockRejectedValue(apiError(409));
    fake.api.relationshipTuples.create.mockRejectedValue(apiError(409));

    await run();

    expect(log).toEqual(
      expect.arrayContaining([
        'ensured role editor on account:harry for sirius@pink.mobile',
        'ensured tuple account:ron parent plan:ron',
      ]),
    );
  });
});
