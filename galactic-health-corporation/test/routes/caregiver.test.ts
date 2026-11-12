import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { assignment, permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { DELETE, GET, POST } from '@/app/api/account/caregiver/[[...user]]/route';
import type { Caregiver } from '@/lib/resources';

let rick: Member;

beforeAll(async () => {
  await setUpDatabase();
  rick = await signUp('Rick');
});

const START = '2026-11-10T10:00:00.000Z';
const END = '2026-12-10T10:00:00.000Z';

function post(payload: unknown, cookie = rick.cookie) {
  return POST(
    request('/api/account/caregiver', { method: 'POST', cookie, body: payload }),
    params({}),
  );
}

function remove(segments: string[], cookie = rick.cookie) {
  return DELETE(
    request(`/api/account/caregiver/${segments.join('/')}`, { method: 'DELETE', cookie }),
    params({ user: segments }),
  );
}

describe('GET /api/account/caregiver', () => {
  it('answers 401 without a session', async () => {
    expect((await GET(request('/api/account/caregiver'), params({}))).status).toBe(401);
  });

  it('answers 404 for a path below the collection', async () => {
    const response = await GET(
      request('/api/account/caregiver/morty', { cookie: rick.cookie }),
      params({ user: ['morty'] }),
    );
    expect(response.status).toBe(404);
  });

  it('answers 403 when Permit denies write on the member record', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    const response = await GET(
      request('/api/account/caregiver', { cookie: rick.cookie }),
      params({}),
    );
    expect(response.status).toBe(403);
    expect(permitFake.check).toHaveBeenCalledWith(rick.id, 'write', {
      type: 'member',
      key: `member_${rick.id}`,
    });
    expect(permitFake.api.roleAssignments.list).not.toHaveBeenCalled();
  });

  it('lists one row per caregiver and shared resource, with the date bounds', async () => {
    permitFake.api.roleAssignments.list.mockImplementation(async (...args: unknown[]) => {
      const { resourceInstance } = args[0] as { resourceInstance: string };
      if (resourceInstance === `health_plan:health_plan_${rick.id}`) {
        return [assignment('morty', 'caregiver', resourceInstance)];
      }
      if (resourceInstance === `member:member_${rick.id}`) {
        return [
          assignment('morty', 'caregiver', resourceInstance),
          assignment('ghost', 'caregiver', resourceInstance),
        ];
      }
      return [];
    });
    permitFake.api.users.get.mockImplementation(async (key: unknown) => {
      if (key === 'ghost') throw permitApiError(404);
      return permitUser('morty', {
        first_name: 'Morty',
        attributes: {
          caregiver_bounds: {
            [`member:member_${rick.id}`]: { start_date: START, end_date: END },
          },
        },
      });
    });

    const response = await GET(
      request('/api/account/caregiver', { cookie: rick.cookie }),
      params({}),
    );

    expect(response.status).toBe(200);
    const rows = await body<Caregiver[]>(response);
    // The caregiver Permit no longer knows is left out.
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({ resource: 'member', startDate: START, endDate: END }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ resource: 'health_plan', startDate: '', endDate: '' }),
    );
    expect(permitFake.api.users.get).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/account/caregiver', () => {
  const valid = { user: 'morty', resource: 'health_plan', startDate: START, endDate: END };

  it('answers 401 without a session', async () => {
    const response = await POST(
      request('/api/account/caregiver', { method: 'POST', body: valid }),
      params({}),
    );
    expect(response.status).toBe(401);
  });

  it.each([
    ['an unknown resource', { ...valid, resource: 'wallet' }],
    ['a missing user', { ...valid, user: '' }],
    ['dates that do not parse', { ...valid, startDate: 'soon' }],
    ['an end before the start', { ...valid, startDate: END, endDate: START }],
    ['a window over a year', { ...valid, endDate: '2028-01-01T00:00:00.000Z' }],
  ])('answers 400 for %s', async (_case, payload) => {
    const response = await post(payload);
    expect(response.status).toBe(400);
    expect(permitFake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('answers 400 when members name themselves', async () => {
    expect((await post({ ...valid, user: rick.id })).status).toBe(400);
  });

  it('answers 403 when Permit denies write on the member record', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    expect((await post(valid)).status).toBe(403);
    expect(permitFake.api.users.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a caregiver Permit does not know', async () => {
    expect((await post(valid)).status).toBe(404);
    expect(permitFake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it("stores the bounds on the caregiver and assigns the role on the owner's instance", async () => {
    const existing = { 'member:member_summer': { start_date: START, end_date: END } };
    permitFake.api.users.get.mockResolvedValueOnce(
      permitUser('morty', { attributes: { phoneNumber: '1', caregiver_bounds: existing } }),
    );

    const response = await post(valid);

    expect(response.status).toBe(200);
    const instance = `health_plan:health_plan_${rick.id}`;
    expect(permitFake.api.users.update).toHaveBeenCalledWith('morty', {
      attributes: {
        phoneNumber: '1',
        caregiver_bounds: { ...existing, [instance]: { start_date: START, end_date: END } },
      },
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'caregiver',
      resource_instance: instance,
      tenant: 'default',
    });
  });

  it('succeeds when the caregiver already has the role (409)', async () => {
    permitFake.api.users.get.mockResolvedValueOnce(permitUser('morty'));
    permitFake.api.roleAssignments.assign.mockRejectedValueOnce(permitApiError(409));
    expect((await post(valid)).status).toBe(200);
  });

  it('answers 502 when the assignment fails', async () => {
    permitFake.api.users.get.mockResolvedValueOnce(permitUser('morty'));
    permitFake.api.roleAssignments.assign.mockRejectedValueOnce(permitApiError(422, 'bad role'));
    const response = await post(valid);
    expect(response.status).toBe(502);
    expect(await body(response)).toMatchObject({ detail: 'bad role' });
  });
});

describe('DELETE /api/account/caregiver/<caregiver>/<resource>', () => {
  it('answers 401 without a session', async () => {
    const response = await DELETE(
      request('/api/account/caregiver/morty/member', { method: 'DELETE' }),
      params({ user: ['morty', 'member'] }),
    );
    expect(response.status).toBe(401);
  });

  it('answers 400 without a caregiver or with an unknown resource', async () => {
    expect((await remove([])).status).toBe(400);
    expect((await remove(['morty', 'wallet'])).status).toBe(400);
  });

  it('answers 403 when Permit denies write on the member record', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    expect((await remove(['morty', 'member'])).status).toBe(403);
    expect(permitFake.api.roleAssignments.unassign).not.toHaveBeenCalled();
  });

  it('answers 404 for a caregiver Permit does not know', async () => {
    expect((await remove(['nobody', 'member'])).status).toBe(404);
  });

  it('drops the bounds and unassigns the role, even when it is already gone', async () => {
    const instance = `member:member_${rick.id}`;
    const other = { start_date: START, end_date: END };
    permitFake.api.users.get.mockResolvedValueOnce(
      permitUser('morty', {
        attributes: { caregiver_bounds: { [instance]: other, 'member:member_summer': other } },
      }),
    );
    permitFake.api.roleAssignments.unassign.mockRejectedValueOnce(permitApiError(404));

    const response = await remove(['morty', 'member']);

    expect(response.status).toBe(200);
    expect(permitFake.api.users.update).toHaveBeenCalledWith('morty', {
      attributes: { caregiver_bounds: { 'member:member_summer': other } },
    });
    expect(permitFake.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'caregiver',
      resource_instance: instance,
      tenant: 'default',
    });
  });
});
