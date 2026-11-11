import { beforeEach, describe, expect, it, vi } from 'vitest';
import assignmentRoute from '#pages/api/representative/[representative]/[customer]';
import listRoute from '#pages/api/representative/index';
import {
  allow,
  assignment,
  assignments,
  directory,
  fake,
  resetFake,
  userRead,
} from '#test/fake-permit';
import { call } from '#test/http';
import { apiError } from '#test/permit-errors';

vi.mock('permitio', async (importOriginal) =>
  (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
);

const albus = 'albus@pink.mobile';
const sirius = 'sirius@pink.mobile';
const luna = 'luna@pink.mobile';

beforeEach(() => {
  resetFake();
  directory(
    [
      userRead(sirius, 'Sirius Black'),
      userRead(luna, 'Luna Lovegood'),
      userRead('harry@potter.io', 'Harry Potter'),
      userRead('ron@weasley.me', 'Ron Weasley'),
    ],
    () => apiError(404),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/representative', () => {
  it('lists each representative with the owners of the accounts they edit', async () => {
    allow([albus, 'list', 'representatives']);
    assignments([
      assignment(sirius, 'representative'),
      assignment(luna, 'representative'),
      assignment(sirius, 'editor', 'account:harry'),
      assignment(sirius, 'editor', 'plan:ron'),
      assignment(luna, 'editor', 'account:ron'),
      assignment('harry@potter.io', 'owner', 'account:harry'),
      assignment('ron@weasley.me', 'owner', 'account:ron'),
      assignment('ron@weasley.me', 'representative', 'account:ron'),
    ]);

    const answer = await call(listRoute, { persona: albus });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      {
        key: luna,
        email: luna,
        firstName: 'Luna',
        lastName: 'Lovegood',
        customers: [
          { key: 'ron@weasley.me', email: 'ron@weasley.me', firstName: 'Ron', lastName: 'Weasley' },
        ],
      },
      {
        key: sirius,
        email: sirius,
        firstName: 'Sirius',
        lastName: 'Black',
        customers: [
          {
            key: 'harry@potter.io',
            email: 'harry@potter.io',
            firstName: 'Harry',
            lastName: 'Potter',
          },
        ],
      },
    ]);
    expect(fake.api.roleAssignments.list).toHaveBeenCalledWith({
      role: 'representative',
      tenant: 'default',
      perPage: 100,
    });
  });

  it('lists a representative without customers with an empty list', async () => {
    allow([albus, 'list', 'representatives']);
    assignments([assignment(luna, 'representative')]);

    const answer = await call(listRoute, { persona: albus });

    expect(answer.body).toEqual([expect.objectContaining({ key: luna, customers: [] })]);
  });

  it('denies a representative with 403', async () => {
    const answer = await call(listRoute, { persona: sirius });

    expect(answer).toMatchObject({
      status: 403,
      body: { error: `User ${sirius} is not allowed to list representatives` },
    });
    expect(fake.api.roleAssignments.list).not.toHaveBeenCalled();
  });
});

describe('POST and DELETE /api/representative/:representative/:customer', () => {
  const send = (method: string, persona: string, representative: string, customer: string) =>
    call(assignmentRoute, { method, persona, query: { representative, customer } });

  beforeEach(() => {
    assignments([assignment(sirius, 'representative'), assignment(luna, 'representative')]);
  });

  it("makes the representative an editor on the customer's account", async () => {
    allow([albus, 'assign', 'representatives']);

    const answer = await send('POST', albus, sirius, 'ron@weasley.me');

    expect(answer).toMatchObject({
      status: 200,
      body: { representative: sirius, customer: 'ron@weasley.me' },
    });
    expect(fake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: sirius,
      role: 'editor',
      resource_instance: 'account:ron',
    });
  });

  it('refuses to give customers to anyone but a representative', async () => {
    allow([albus, 'assign', 'representatives']);
    assignments([
      assignment(sirius, 'representative', 'account:harry'),
      assignment('harry@potter.io', 'owner', 'account:harry'),
    ]);

    const customer = await send('POST', albus, 'harry@potter.io', 'ron@weasley.me');
    const resourceRoleOnly = await send('POST', albus, sirius, 'ron@weasley.me');

    expect(customer).toMatchObject({
      status: 400,
      body: { error: 'harry@potter.io is not a representative' },
    });
    expect(resourceRoleOnly.status).toBe(400);
    expect(fake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('refuses a representative Permit does not know', async () => {
    allow([albus, 'assign', 'representatives']);
    fake.api.roleAssignments.list.mockRejectedValue(apiError(404));

    const answer = await send('POST', albus, 'nobody@pink.mobile', 'ron@weasley.me');

    expect(answer).toMatchObject({
      status: 400,
      body: { error: 'nobody@pink.mobile is not a representative' },
    });
  });

  it('removes the editor role on DELETE', async () => {
    allow([albus, 'assign', 'representatives']);

    const answer = await send('DELETE', albus, sirius, 'harry@potter.io');

    expect(answer.status).toBe(200);
    expect(fake.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: sirius,
      role: 'editor',
      resource_instance: 'account:harry',
      tenant: 'default',
    });
  });

  it('denies anyone without the assign permission, for both methods', async () => {
    const assign = await send('POST', sirius, sirius, 'ron@weasley.me');
    const unassign = await send('DELETE', sirius, sirius, 'harry@potter.io');

    expect(assign).toMatchObject({
      status: 403,
      body: { error: `User ${sirius} is not allowed to assign representatives` },
    });
    expect(unassign).toMatchObject({
      status: 403,
      body: { error: `User ${sirius} is not allowed to unassign representatives` },
    });
    expect(fake.api.roleAssignments.assign).not.toHaveBeenCalled();
    expect(fake.api.roleAssignments.unassign).not.toHaveBeenCalled();
  });

  it('answers 404 when the customer has no account', async () => {
    allow([albus, 'assign', 'representatives']);
    fake.api.roleAssignments.assign.mockRejectedValue(apiError(404));

    const answer = await send('POST', albus, sirius, 'neville@longbottom.uk');

    expect(answer).toMatchObject({
      status: 404,
      body: { error: 'There is no account neville: neville@longbottom.uk is not a customer' },
    });
  });

  it('answers 404 when the representative is not assigned to the customer', async () => {
    allow([albus, 'assign', 'representatives']);
    fake.api.roleAssignments.unassign.mockRejectedValue(apiError(404));

    const answer = await send('DELETE', albus, luna, 'harry@potter.io');

    expect(answer).toMatchObject({
      status: 404,
      body: { error: `${luna} is not assigned to harry@potter.io` },
    });
  });

  it('answers 502 for any other Permit API failure', async () => {
    allow([albus, 'assign', 'representatives']);
    fake.api.roleAssignments.assign.mockRejectedValue(apiError(500));

    const answer = await send('POST', albus, sirius, 'ron@weasley.me');

    expect(answer.status).toBe(502);
  });

  it('rejects keys that are not email addresses', async () => {
    const badRepresentative = await send('POST', albus, 'sirius', 'ron@weasley.me');
    const badCustomer = await send('POST', albus, sirius, 'ron');

    expect(badRepresentative).toMatchObject({
      status: 400,
      body: { error: 'The representative must be an email address' },
    });
    expect(badCustomer).toMatchObject({
      status: 400,
      body: { error: 'The customer must be an email address' },
    });
    expect(fake.check).not.toHaveBeenCalled();
  });

  it('answers 405 with both allowed methods for PUT', async () => {
    const answer = await send('PUT', albus, sirius, 'ron@weasley.me');

    expect(answer).toMatchObject({ status: 405, headers: { Allow: 'POST, DELETE' } });
  });
});
