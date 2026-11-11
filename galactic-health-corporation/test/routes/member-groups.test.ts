import { beforeAll, describe, expect, it } from 'vitest';
import { body, type Member, params, request, setUpDatabase, signUp } from '#test/http';
import { assignment, permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { DELETE, GET, POST } from '@/app/api/account/member-groups/[[...action]]/route';
import type { MemberGroup } from '@/lib/resources';

let rick: Member;

beforeAll(async () => {
  await setUpDatabase();
  rick = await signUp('Rick');
});

function post(action: string[] | undefined, payload: unknown, { signedIn = true } = {}) {
  const path = ['/api/account/member-groups', ...(action ?? [])].join('/');
  return POST(
    request(path, { method: 'POST', body: payload, ...(signedIn ? { cookie: rick.cookie } : {}) }),
    params(action === undefined ? {} : { action }),
  );
}

describe('GET /api/account/member-groups', () => {
  it('answers 401 without a session', async () => {
    expect((await GET(request('/api/account/member-groups'), params({}))).status).toBe(401);
  });

  it('lists the groups the member administers with their names and other members', async () => {
    permitFake.api.roleAssignments.list.mockImplementation(async (...args: unknown[]) => {
      const filter = args[0] as { user?: string; resourceInstance?: string };
      if (filter.user === rick.id) return [assignment(rick.id, 'admin', 'member_group:family')];
      return [
        assignment('morty', 'org_member', filter.resourceInstance),
        assignment(rick.id, 'org_member', filter.resourceInstance),
      ];
    });
    permitFake.api.resourceInstances.get.mockResolvedValueOnce({
      key: 'family',
      resource: 'member_group',
      attributes: { name: 'Smith Family' },
    });
    permitFake.api.users.get.mockImplementation(async (key: unknown) => permitUser(String(key)));

    const response = await GET(
      request('/api/account/member-groups', { cookie: rick.cookie }),
      params({}),
    );

    expect(response.status).toBe(200);
    const groups = await body<MemberGroup[]>(response);
    expect(groups).toEqual([
      expect.objectContaining({
        key: 'family',
        name: 'Smith Family',
        members: [expect.anything()],
      }),
    ]);
    expect(groups[0]?.members[0]?.id).toBe('morty');
    expect(permitFake.api.resourceInstances.get).toHaveBeenCalledWith('member_group:family');
  });
});

describe('POST /api/account/member-groups (create)', () => {
  it('answers 401 without a session', async () => {
    expect((await post(undefined, { name: 'Club' }, { signedIn: false })).status).toBe(401);
    expect(permitFake.api.resourceInstances.create).not.toHaveBeenCalled();
  });

  it('creates the group, makes the member its admin and links their profile', async () => {
    const response = await post(undefined, { name: 'Smith Family' });

    expect(response.status).toBe(201);
    const key = `member_group_${rick.id}_smith_family`;
    expect(await body(response)).toEqual({ key, name: 'Smith Family', members: [] });
    expect(permitFake.api.resourceInstances.create).toHaveBeenCalledWith({
      resource: 'member_group',
      key,
      tenant: 'default',
      attributes: { name: 'Smith Family' },
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: rick.id,
      role: 'admin',
      resource_instance: `member_group:${key}`,
      tenant: 'default',
    });
    expect(permitFake.api.relationshipTuples.create).toHaveBeenCalledWith({
      subject: `member_group:${key}`,
      relation: 'belongs',
      object: `profile:profile_${rick.id}`,
      tenant: 'default',
    });
  });

  it('answers 409 when the member already has a group with that name', async () => {
    permitFake.api.resourceInstances.create.mockRejectedValueOnce(permitApiError(409));
    expect((await post(undefined, { name: 'Smith Family' })).status).toBe(409);
  });

  it.each([['!!!'], ['x'.repeat(51)], ['']])('answers 400 for the name %j', async (name) => {
    expect((await post(undefined, { name })).status).toBe(400);
    expect(permitFake.api.resourceInstances.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/account/member-groups/assign', () => {
  const payload = { email: 'Morty@Example.com', group: 'family' };

  it('answers 403 when Permit denies assign on the group', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    expect((await post(['assign'], payload)).status).toBe(403);
    expect(permitFake.check).toHaveBeenCalledWith(rick.id, 'assign', 'member_group:family');
    expect(permitFake.api.users.list).not.toHaveBeenCalled();
  });

  it('answers 404 when no member has that exact email', async () => {
    permitFake.api.users.list.mockResolvedValueOnce({
      data: [permitUser('mortimer', { email: 'mortimer@example.com' })],
    });
    expect((await post(['assign'], payload)).status).toBe(404);
  });

  it("adds the member by key and links the group to the member's profile", async () => {
    permitFake.api.users.list.mockResolvedValueOnce({
      data: [permitUser('morty', { email: 'morty@example.com' })],
    });

    expect((await post(['assign'], payload)).status).toBe(200);

    expect(permitFake.api.users.list).toHaveBeenCalledWith({ search: 'morty@example.com' });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'org_member',
      resource_instance: 'member_group:family',
      tenant: 'default',
    });
    expect(permitFake.api.relationshipTuples.create).toHaveBeenCalledWith({
      subject: 'member_group:family',
      relation: 'belongs',
      object: 'profile:profile_morty',
      tenant: 'default',
    });
  });

  it('answers 409 when the member is in the group already, without assigning again', async () => {
    permitFake.api.users.list.mockResolvedValueOnce({
      data: [permitUser('morty', { email: 'morty@example.com' })],
    });
    permitFake.api.roleAssignments.list.mockResolvedValueOnce([
      assignment('morty', 'org_member', 'member_group:family'),
    ]);
    expect((await post(['assign'], payload)).status).toBe(409);
    expect(permitFake.api.roleAssignments.list).toHaveBeenCalledWith({
      user: 'morty',
      role: 'org_member',
      resourceInstance: 'member_group:family',
    });
    expect(permitFake.api.roleAssignments.assign).not.toHaveBeenCalled();
  });

  it('succeeds when Permit answers 409 to an assignment it already has', async () => {
    permitFake.api.users.list.mockResolvedValueOnce({
      data: [permitUser('morty', { email: 'morty@example.com' })],
    });
    permitFake.api.roleAssignments.assign.mockRejectedValueOnce(permitApiError(409));
    expect((await post(['assign'], payload)).status).toBe(200);
  });

  it('answers 400 without an email', async () => {
    expect((await post(['assign'], { group: 'family' })).status).toBe(400);
  });
});

describe('POST /api/account/member-groups/unassign', () => {
  it('answers 403 when Permit denies assign on the group', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    expect((await post(['unassign'], { member: 'morty', group: 'family' })).status).toBe(403);
    expect(permitFake.api.roleAssignments.unassign).not.toHaveBeenCalled();
  });

  it('removes the role and the profile link, tolerating ones already gone', async () => {
    permitFake.api.relationshipTuples.delete.mockRejectedValueOnce(permitApiError(404));
    expect((await post(['unassign'], { member: 'morty', group: 'family' })).status).toBe(200);
    expect(permitFake.api.roleAssignments.unassign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'org_member',
      resource_instance: 'member_group:family',
      tenant: 'default',
    });
    expect(permitFake.api.relationshipTuples.delete).toHaveBeenCalledWith({
      subject: 'member_group:family',
      relation: 'belongs',
      object: 'profile:profile_morty',
    });
  });
});

describe('POST with an unknown action', () => {
  it('answers 404', async () => {
    expect((await post(['rename'], {})).status).toBe(404);
    expect((await post(['assign', 'extra'], {})).status).toBe(404);
  });
});

describe('DELETE /api/account/member-groups', () => {
  function remove(payload: unknown) {
    return DELETE(
      request('/api/account/member-groups', {
        method: 'DELETE',
        cookie: rick.cookie,
        body: payload,
      }),
      params({}),
    );
  }

  it('answers 403 when Permit denies assign on the group', async () => {
    permitFake.check.mockResolvedValueOnce(false);
    expect((await remove({ key: 'family' })).status).toBe(403);
    expect(permitFake.api.resourceInstances.delete).not.toHaveBeenCalled();
  });

  it('deletes the group instance', async () => {
    expect((await remove({ key: 'family' })).status).toBe(200);
    expect(permitFake.api.resourceInstances.delete).toHaveBeenCalledWith('member_group:family');
  });

  it('answers 400 without a key', async () => {
    expect((await remove({})).status).toBe(400);
  });

  it('answers 404 for a path below the collection', async () => {
    const response = await DELETE(
      request('/api/account/member-groups/family', {
        method: 'DELETE',
        cookie: rick.cookie,
        body: { key: 'family' },
      }),
      params({ action: ['family'] }),
    );
    expect(response.status).toBe(404);
    expect(permitFake.check).not.toHaveBeenCalled();
  });
});
