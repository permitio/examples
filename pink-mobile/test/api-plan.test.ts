import { beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '#pages/api/plan/[customer]/[plan]';
import { allow, directory, fake, resetFake, userRead } from '#test/fake-permit';
import { call } from '#test/http';
import { apiError } from '#test/permit-errors';

vi.mock('permitio', async (importOriginal) =>
  (await import('#test/fake-permit')).withFakePermit(await importOriginal()),
);

const sirius = 'sirius@pink.mobile';
const harry = 'harry@potter.io';
const ownPlan = (user: string) => ({ type: 'plan', attributes: { owner: user } });

beforeEach(() => {
  resetFake();
  directory(
    [
      userRead(harry, 'Harry Potter', { plan: 'VIP', blocked: false, nickname: 'the boy' }),
      userRead('ron@weasley.me', 'Ron Weasley', { plan: 'Standard', blocked: true }),
    ],
    () => apiError(404),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const change = (persona: string, customer: string, plan: string) =>
  call(handler, { method: 'POST', persona, query: { customer, plan } });

describe('POST /api/plan/:customer/:plan', () => {
  it('lets a representative change the plan of an active customer they edit', async () => {
    allow(
      [harry, 'manage', 'account:harry'],
      [sirius, 'change', 'plan:harry'],
      [harry, 'change', ownPlan(harry)],
    );

    const answer = await change(sirius, harry, 'Standard');

    expect(answer).toMatchObject({ status: 200, body: { plan: 'Standard' } });
    expect(fake.api.users.update).toHaveBeenCalledWith(harry, {
      attributes: { plan: 'Standard', blocked: false, nickname: 'the boy' },
    });
  });

  it('lets an active customer who owns their account change their own plan', async () => {
    allow([harry, 'manage', 'account:harry'], [harry, 'change', ownPlan(harry)]);

    const answer = await change(harry, harry, 'Standard');

    expect(answer.status).toBe(200);
    expect(fake.check).not.toHaveBeenCalledWith(harry, 'change', 'plan:harry');
  });

  it('denies a customer who does not own the account, though their plan is theirs', async () => {
    const hermione = 'hermione@granger.app';
    allow([hermione, 'change', ownPlan(hermione)]);

    const answer = await change(hermione, hermione, 'Standard');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: `User ${hermione} is not an account owner` },
    });
    expect(fake.api.users.update).not.toHaveBeenCalled();
  });

  it('denies a representative the plan of a customer who owns no account', async () => {
    const hermione = 'hermione@granger.app';
    allow([sirius, 'change', 'plan:hermione'], [hermione, 'change', ownPlan(hermione)]);

    const answer = await change(sirius, hermione, 'Standard');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: `User ${hermione} is not an account owner` },
    });
    expect(fake.api.users.update).not.toHaveBeenCalled();
  });

  it('denies a representative who is not an editor on the customer', async () => {
    allow([harry, 'manage', 'account:harry'], [harry, 'change', ownPlan(harry)]);

    const answer = await change('luna@pink.mobile', harry, 'Standard');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: `User luna@pink.mobile is not allowed to change plan for ${harry}` },
    });
    expect(fake.api.users.update).not.toHaveBeenCalled();
  });

  it('denies a representative when the customer is blocked', async () => {
    allow(
      ['ron@weasley.me', 'manage', 'account:ron'],
      ['luna@pink.mobile', 'change', 'plan:ron'],
      ['ron@weasley.me', 'view', ownPlan('ron@weasley.me')],
    );

    const answer = await change('luna@pink.mobile', 'ron@weasley.me', 'VIP');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: "You can't change plan for ron@weasley.me as their account is blocked" },
    });
    expect(fake.check).toHaveBeenCalledWith('ron@weasley.me', 'change', ownPlan('ron@weasley.me'));
    expect(fake.api.users.update).not.toHaveBeenCalled();
  });

  it('denies a blocked customer their own plan', async () => {
    allow(['ron@weasley.me', 'manage', 'account:ron']);

    const answer = await change('ron@weasley.me', 'ron@weasley.me', 'VIP');

    expect(answer).toMatchObject({
      status: 403,
      body: { error: "You can't change plan for ron@weasley.me as their account is blocked" },
    });
    expect(fake.api.users.update).not.toHaveBeenCalled();
  });

  it('rejects a plan that does not exist', async () => {
    const answer = await change(sirius, harry, 'Gold');

    expect(answer).toMatchObject({
      status: 400,
      body: { error: 'The plan must be one of: VIP, Standard' },
    });
    expect(fake.check).not.toHaveBeenCalled();
  });

  it('rejects a customer key that is not an email address', async () => {
    const answer = await change(sirius, 'harry', 'VIP');

    expect(answer).toMatchObject({ status: 400 });
  });

  it('answers 502 when Permit fails to save the plan', async () => {
    allow(
      [harry, 'manage', 'account:harry'],
      [sirius, 'change', 'plan:harry'],
      [harry, 'change', ownPlan(harry)],
    );
    fake.api.users.update.mockRejectedValue(apiError(422));

    const answer = await change(sirius, harry, 'Standard');

    expect(answer.status).toBe(502);
  });

  it('answers 405 for GET', async () => {
    const answer = await call(handler, {
      persona: sirius,
      query: { customer: harry, plan: 'VIP' },
    });

    expect(answer).toMatchObject({ status: 405, headers: { Allow: 'POST' } });
  });
});
