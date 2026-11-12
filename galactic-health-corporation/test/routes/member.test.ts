import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { assignment, permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { GET } from '@/app/api/account/member/route';
import type { Person } from '@/lib/resources';

let rick: Member;

beforeAll(async () => {
  await setUpDatabase();
  rick = await signUp('Rick');
});

describe('GET /api/account/member', () => {
  it('answers 401 without a session', async () => {
    const response = await GET(request('/api/account/member'), params({}));
    expect(response.status).toBe(401);
  });

  it('lists the other members of the groups the member administers, once each', async () => {
    permitFake.api.roleAssignments.list.mockImplementation(async (...args: unknown[]) => {
      const filter = args[0] as { user?: string; resourceInstance?: string };
      if (filter.user === rick.id) {
        return [
          assignment(rick.id, 'admin', 'member_group:a'),
          assignment(rick.id, 'admin', 'member_group:b'),
          // An admin role on something other than a group is ignored.
          assignment(rick.id, 'admin', 'other:x'),
        ];
      }
      if (filter.resourceInstance === 'member_group:a') {
        return [
          assignment('morty', 'org_member', 'member_group:a'),
          assignment(rick.id, 'org_member'),
        ];
      }
      return [
        assignment('morty', 'org_member', 'member_group:b'),
        assignment('bird', 'org_member'),
      ];
    });
    permitFake.api.users.get.mockImplementation(async (key: unknown) => permitUser(String(key)));

    const response = await GET(request('/api/account/member', { cookie: rick.cookie }), params({}));

    expect(response.status).toBe(200);
    const members = await body<Person[]>(response);
    expect(members.map((member) => member.id).toSorted()).toEqual(['bird', 'morty']);
    expect(permitFake.api.roleAssignments.list).toHaveBeenCalledWith({
      resourceInstance: 'member_group:a',
      role: 'org_member',
    });
    expect(permitFake.api.roleAssignments.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ resourceInstance: 'other:x' }),
    );
  });

  it('returns an empty list for a member who administers no group', async () => {
    const response = await GET(request('/api/account/member', { cookie: rick.cookie }), params({}));
    expect(await body(response)).toEqual([]);
  });

  it('answers 502 when Permit fails', async () => {
    permitFake.api.roleAssignments.list.mockRejectedValueOnce(permitApiError(500));
    const response = await GET(request('/api/account/member', { cookie: rick.cookie }), params({}));
    expect(response.status).toBe(502);
  });
});
