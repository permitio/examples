import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, useTestEnv } from '#test/fakes';
import { testServer } from '#test/server';

const permit = await vi.hoisted(async () => (await import('#test/fake-permit')).fakePermit());
vi.mock('permitio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permitio')>()),
  Permit: vi.fn(function Permit() {
    return permit;
  }),
}));

const server = testServer();
const change = { user: 'dana', role: 'vendor', tenant: 'washington', isGrant: true };

beforeEach(() => {
  vi.resetAllMocks();
  useTestEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /users', () => {
  it('creates the user and grants the role in the city', async () => {
    const reply = await server.post('/users', change);

    expect(reply).toEqual({
      status: 200,
      body: { message: 'Role vendor granted to dana in washington' },
    });
    expect(permit.api.users.create).toHaveBeenCalledWith({ key: 'dana' });
    expect(permit.api.users.sync).not.toHaveBeenCalled();
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'dana',
      role: 'vendor',
      tenant: 'washington',
    });
  });

  it('grants the role to a user who exists and has it already (409s)', async () => {
    permit.api.users.create.mockRejectedValue(apiError(409));
    permit.api.roleAssignments.assign.mockRejectedValue(apiError(409));

    expect((await server.post('/users', change)).status).toBe(200);
  });

  it("syncs a rider's number_of_rides", async () => {
    const rider = { ...change, role: 'rider', noOfRides: 650 };

    expect((await server.post('/users', rider)).status).toBe(200);
    expect(permit.api.users.sync).toHaveBeenCalledWith({
      key: 'dana',
      attributes: { number_of_rides: 650 },
    });
    expect(permit.api.users.create).not.toHaveBeenCalled();
  });

  it('revokes the role, and treats a role the user did not have (404) as revoked', async () => {
    permit.api.roleAssignments.unassign.mockRejectedValue(apiError(404));

    const reply = await server.post('/users', { ...change, isGrant: false });

    expect(reply.body).toEqual({ message: 'Role vendor revoked from dana in washington' });
    expect(permit.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: 'dana',
      role: 'vendor',
      tenant: 'washington',
    });
  });

  it.each([
    ['an unknown role', { ...change, role: 'chef' }, 'Unknown role: chef'],
    ['an unknown city', { ...change, tenant: 'oregon' }, 'Unknown city: oregon'],
    ['isGrant missing', { ...change, isGrant: undefined }, 'isGrant must be true or false.'],
    ['negative rides', { ...change, noOfRides: -1 }, 'noOfRides must be'],
    ['a user key with spaces', { ...change, user: 'da na' }, 'user must be'],
  ])('answers 400 for %s, without calling Permit', async (_case, body, message) => {
    const reply = await server.post<{ message: string }>('/users', body);

    expect(reply.status).toBe(400);
    expect(reply.body.message).toContain(message);
    expect(permit.api.users.create).not.toHaveBeenCalled();
  });

  it('answers 502 when Permit fails to grant the role', async () => {
    permit.api.roleAssignments.assign.mockRejectedValue(apiError(500));

    const reply = await server.post('/users', change);

    expect(reply).toMatchObject({
      status: 502,
      body: {
        message: 'Permit could not give dana the vendor role in washington (Permit answered 500).',
      },
    });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('DELETE /users', () => {
  it('deletes the user from Permit', async () => {
    const reply = await server.delete('/users', { user: 'dana' });

    expect(reply).toEqual({ status: 200, body: { message: 'User dana removed from Permit' } });
    expect(permit.api.users.delete).toHaveBeenCalledWith('dana');
  });

  it('treats a user Permit does not have (404) as removed', async () => {
    permit.api.users.delete.mockRejectedValue(apiError(404));

    expect((await server.delete('/users', { user: 'dana' })).status).toBe(200);
  });

  it('answers 400 without a user', async () => {
    expect((await server.delete('/users', {})).status).toBe(400);
    expect(permit.api.users.delete).not.toHaveBeenCalled();
  });

  it('answers 502 when Permit fails to delete', async () => {
    permit.api.users.delete.mockRejectedValue(apiError(500));

    expect((await server.delete('/users', { user: 'dana' })).status).toBe(502);
  });
});
