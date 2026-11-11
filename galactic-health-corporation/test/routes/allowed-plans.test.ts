import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { assignment, permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { GET } from '@/app/api/allowed-plans/route';
import type { Person } from '@/lib/resources';

let morty: Member;

beforeAll(async () => {
  await setUpDatabase();
  morty = await signUp('Morty');
});

describe('GET /api/allowed-plans', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(request('/api/allowed-plans'), params({}));
    expect(response.status).toBe(401);
  });

  it('lists the member first, then each member they are a caregiver for, once', async () => {
    permitFake.api.roleAssignments.list.mockResolvedValueOnce([
      assignment(morty.id, 'caregiver', 'member:member_rick'),
      assignment(morty.id, 'caregiver', 'health_plan:health_plan_rick'),
      assignment(morty.id, 'caregiver', 'medical_records:medical_records_summer'),
      // Malformed or own instances are skipped.
      assignment(morty.id, 'caregiver', 'broken'),
      assignment(morty.id, 'caregiver', `member:member_${morty.id}`),
    ]);
    permitFake.api.users.get.mockImplementation(async (key: unknown) => permitUser(String(key)));

    const response = await GET(request('/api/allowed-plans', { cookie: morty.cookie }), params({}));

    expect(response.status).toBe(200);
    const plans = await body<Person[]>(response);
    expect(plans.map((plan) => plan.id)).toEqual([morty.id, 'rick', 'summer']);
    expect(plans[0]).toMatchObject({ firstName: 'Morty', relationship: 'Self' });
    expect(permitFake.api.roleAssignments.list).toHaveBeenCalledWith({
      user: morty.id,
      role: 'caregiver',
    });
  });

  it('answers 502 when a caregiver lookup fails', async () => {
    permitFake.api.roleAssignments.list.mockResolvedValueOnce([
      assignment(morty.id, 'caregiver', 'member:member_rick'),
    ]);
    permitFake.api.users.get.mockRejectedValueOnce(permitApiError(500));
    const response = await GET(request('/api/allowed-plans', { cookie: morty.cookie }), params({}));
    expect(response.status).toBe(502);
  });
});
