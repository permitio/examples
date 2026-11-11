import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '#pages/api/account/[id]';
import { allow, directory, fake, resetFake, userRead } from '#test/fake-permit';
import { call } from '#test/http';
import { apiError } from '#test/permit-errors';

vi.mock('permitio', async (importOriginal) =>
  (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
);

const sirius = 'sirius@pink.mobile';

beforeEach(() => {
  resetFake();
  directory([userRead('harry@potter.io', 'Harry Potter', { plan: 'VIP' })], () => apiError(404));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const open = (customer: string, persona = sirius) =>
  call(handler, { persona, query: { id: customer } });

describe('GET /api/account/:customer', () => {
  it("shows the plan to a representative who may view the owner's account", async () => {
    allow(['harry@potter.io', 'manage', 'account:harry'], [sirius, 'view', 'account:harry']);

    const answer = await open('harry@potter.io');

    expect(answer).toMatchObject({ status: 200, body: { plan: 'VIP' } });
    expect(fake.check).toHaveBeenCalledWith('harry@potter.io', 'manage', 'account:harry');
    expect(fake.check).toHaveBeenCalledWith(sirius, 'view', 'account:harry');
  });

  it('denies a customer who owns no account, such as a member of another', async () => {
    allow([sirius, 'view', 'account:hermione']);

    const answer = await open('hermione@granger.app');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: 'User hermione@granger.app is not an account owner' },
    });
    expect(fake.api.users.get).not.toHaveBeenCalled();
  });

  it('denies a representative who is not an editor on the account', async () => {
    allow(['ron@weasley.me', 'manage', 'account:ron']);

    const answer = await open('ron@weasley.me');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: `User ${sirius} is not authorized to view account ron` },
    });
    expect(fake.api.users.get).not.toHaveBeenCalled();
  });

  it('rejects a customer key that is not an email address', async () => {
    const answer = await open('harry');

    expect(answer).toMatchObject({ status: 400 });
    expect(fake.check).not.toHaveBeenCalled();
  });

  it('answers 404 when Permit has no such user', async () => {
    allow(['ghost@potter.io', 'manage', 'account:ghost'], [sirius, 'view', 'account:ghost']);

    const answer = await open('ghost@potter.io');

    expect(answer).toMatchObject({ status: 404, body: { error: expect.stringContaining('404') } });
  });

  it('answers 405 for anything but GET', async () => {
    const answer = await call(handler, {
      method: 'DELETE',
      persona: sirius,
      query: { id: 'x@y.z' },
    });

    expect(answer.status).toBe(405);
  });
});
