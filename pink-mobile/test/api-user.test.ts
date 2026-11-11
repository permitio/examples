import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '#pages/api/user';
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
import { apiError, pdpDown } from '#test/permit-errors';

vi.mock('permitio', async (importOriginal) =>
  (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
);

const harry = userRead('harry@potter.io', 'Harry Potter', { plan: 'VIP', blocked: false });
const hermione = userRead('hermione@granger.app', 'Hermione Granger', { plan: 'VIP' });
const ron = userRead('ron@weasley.me', 'Ron Weasley', { plan: 'Standard', blocked: true });

beforeEach(() => {
  resetFake();
  directory([harry, hermione, ron], (key) => apiError(404, { message: `no user ${key}` }));
  assignments([
    assignment('ron@weasley.me', 'owner', 'account:ron'),
    assignment('harry@potter.io', 'owner', 'account:harry'),
    assignment('hermione@granger.app', 'member', 'account:harry'),
    assignment('harry@potter.io', 'member', 'account:ron'),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('GET /api/user', () => {
  it('lists account owners and members once each, by name, with their plan', async () => {
    allow(['albus@pink.mobile', 'list', 'users']);

    const answer = await call(handler, { persona: 'albus@pink.mobile' });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      {
        key: 'harry@potter.io',
        email: 'harry@potter.io',
        firstName: 'Harry',
        lastName: 'Potter',
        plan: 'VIP',
        blocked: false,
      },
      {
        key: 'hermione@granger.app',
        email: 'hermione@granger.app',
        firstName: 'Hermione',
        lastName: 'Granger',
        plan: 'VIP',
        blocked: false,
      },
      {
        key: 'ron@weasley.me',
        email: 'ron@weasley.me',
        firstName: 'Ron',
        lastName: 'Weasley',
        plan: 'Standard',
        blocked: true,
      },
    ]);
    expect(fake.check).toHaveBeenCalledWith('albus@pink.mobile', 'list', 'users');
    expect(fake.api.users.get).toHaveBeenCalledTimes(3);
  });

  it('ignores owner and member roles granted outside an account', async () => {
    allow(['sirius@pink.mobile', 'list', 'users']);
    assignments([
      assignment('harry@potter.io', 'owner', 'account:harry'),
      assignment('ron@weasley.me', 'owner'),
      assignment('hermione@granger.app', 'member', 'plan:harry'),
    ]);

    const answer = await call(handler, { persona: 'sirius@pink.mobile' });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([expect.objectContaining({ key: 'harry@potter.io' })]);
  });

  it('reads no plan from a user whose plan attribute is not a known plan', async () => {
    allow(['albus@pink.mobile', 'list', 'users']);
    directory([userRead('harry@potter.io', 'Harry Potter', { plan: 'Gold' })], () => apiError(404));
    assignments([assignment('harry@potter.io', 'owner', 'account:harry')]);

    const answer = await call(handler, { persona: 'albus@pink.mobile' });

    expect(answer.body).toEqual([expect.objectContaining({ plan: null, blocked: false })]);
  });

  it('denies a customer with 403 and reads nothing from Permit', async () => {
    const answer = await call(handler, { persona: 'harry@potter.io' });

    expect(answer).toMatchObject({
      status: 403,
      body: { error: 'User harry@potter.io is not allowed to list users' },
    });
    expect(fake.api.roleAssignments.list).not.toHaveBeenCalled();
  });

  it('answers 401 when no persona is picked', async () => {
    const answer = await call(handler);

    expect(answer).toMatchObject({
      status: 401,
      body: { error: expect.stringContaining('X-User') },
    });
    expect(fake.check).not.toHaveBeenCalled();
  });

  it('answers 405 with the allowed methods for anything but GET', async () => {
    const answer = await call(handler, { method: 'POST', persona: 'albus@pink.mobile' });

    expect(answer).toMatchObject({ status: 405, headers: { Allow: 'GET' } });
  });

  it('answers 503 when the PDP call fails', async () => {
    fake.check.mockRejectedValue(pdpDown());

    const answer = await call(handler, { persona: 'albus@pink.mobile' });

    expect(answer).toMatchObject({
      status: 503,
      body: { error: expect.stringContaining('The PDP call failed') },
    });
  });

  it('answers 502 when the Permit API fails', async () => {
    allow(['albus@pink.mobile', 'list', 'users']);
    fake.api.roleAssignments.list.mockRejectedValue(apiError(500));

    const answer = await call(handler, { persona: 'albus@pink.mobile' });

    expect(answer).toMatchObject({
      status: 502,
      body: { error: 'Permit API: Request failed with status code 500' },
    });
  });

  it('answers 500 without details for an unexpected error', async () => {
    allow(['albus@pink.mobile', 'list', 'users']);
    fake.api.users.get.mockRejectedValue(new TypeError('secret detail'));

    const answer = await call(handler, { persona: 'albus@pink.mobile' });

    expect(answer).toEqual({
      status: 500,
      body: { error: 'Internal error; the server log has the details' },
      headers: {},
    });
  });
});
