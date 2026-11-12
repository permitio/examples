import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { permitFake } from '#test/permit-fake';
import { POST } from '@/app/api/permissions/route';

let rick: Member;

beforeAll(async () => {
  await setUpDatabase();
  rick = await signUp('Rick');
});

const features = {
  resourcesAndActions: [
    { action: 'view', resource: 'benefits_pg', userAttributes: {}, resourceAttributes: {} },
    { action: 'view', resource: 'alt_medicine_pg', userAttributes: {}, resourceAttributes: {} },
  ],
};

describe('POST /api/permissions', () => {
  it('answers 401 without a session', async () => {
    const response = await POST(
      request('/api/permissions', { method: 'POST', body: features }),
      params({}),
    );
    expect(response.status).toBe(401);
  });

  it("answers permit-fe-sdk's bulk request for the signed-in member", async () => {
    permitFake.bulkCheck.mockResolvedValueOnce([true, false]);
    const response = await POST(
      request(`/api/permissions?user=${rick.id}`, {
        method: 'POST',
        cookie: rick.cookie,
        body: features,
      }),
      params({}),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ permittedList: [true, false] });
    expect(permitFake.bulkCheck).toHaveBeenCalledWith([
      { user: rick.id, action: 'view', resource: 'benefits_pg' },
      { user: rick.id, action: 'view', resource: 'alt_medicine_pg' },
    ]);
  });

  it('refuses to check someone else', async () => {
    const response = await POST(
      request('/api/permissions?user=morty', {
        method: 'POST',
        cookie: rick.cookie,
        body: features,
      }),
      params({}),
    );
    expect(response.status).toBe(403);
    expect(permitFake.bulkCheck).not.toHaveBeenCalled();
  });

  it.each([
    ['no list', {}],
    ['an empty list', { resourcesAndActions: [] }],
    ['a check without a resource', { resourcesAndActions: [{ action: 'view' }] }],
    ['a null check', { resourcesAndActions: [null] }],
    [
      'too many checks',
      { resourcesAndActions: Array.from({ length: 21 }, () => ({ action: 'a', resource: 'r' })) },
    ],
  ])('answers 400 for %s', async (_case, payload) => {
    const response = await POST(
      request('/api/permissions', { method: 'POST', cookie: rick.cookie, body: payload }),
      params({}),
    );
    expect(response.status).toBe(400);
    expect(permitFake.bulkCheck).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON', async () => {
    const response = await POST(
      request('/api/permissions', { method: 'POST', cookie: rick.cookie, body: 'not json' }),
      params({}),
    );
    expect(response.status).toBe(400);
  });
});
