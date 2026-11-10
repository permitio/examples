import type { Permit } from 'permitio';
import {
  denied,
  HttpError,
  json,
  memberRoute,
  readBody,
  rejectSegments,
  requireText,
} from '@/lib/api';
import {
  addGroupMember,
  createGroup,
  groupInstance,
  groupKey,
  removeGroupMember,
} from '@/lib/groups';
import { getPermit, ignoreNotFound } from '@/lib/permit';
import { attributesOf, type MemberGroup, TENANT, toPerson } from '@/lib/resources';

type Params = { action?: string[] };

/** Permit check: assign on the group, which only its admin role has. */
function mayManageGroup(permit: Permit, userKey: string, key: string): Promise<boolean> {
  return permit.check(userKey, 'assign', groupInstance(key));
}

/** The groups the signed-in member administers, each with its other members. */
export const GET = memberRoute<Params>(async (_request, { user, params }) => {
  rejectSegments(params.action);
  const permit = getPermit();
  // Permit read: api.roleAssignments lists the groups this member is the admin of.
  const adminOf = await permit.api.roleAssignments.list({
    user: user.id,
    role: 'admin',
    tenant: TENANT,
  });
  const instances = adminOf.flatMap(({ resource_instance: instance }) =>
    instance?.startsWith('member_group:') ? [instance] : [],
  );
  const groups = await Promise.all(
    instances.map(async (instance): Promise<MemberGroup> => {
      const [group, memberships] = await Promise.all([
        // Permit read: api.resourceInstances returns the group with its name attribute.
        permit.api.resourceInstances.get(instance),
        // Permit read: api.roleAssignments lists the group's org_members.
        permit.api.roleAssignments.list({ resourceInstance: instance, role: 'org_member' }),
      ]);
      const keys = [...new Set(memberships.map((membership) => membership.user))].filter(
        (key) => key !== user.id,
      );
      // Permit read: api.users.get returns each member's profile.
      const members = await Promise.all(keys.map((key) => permit.api.users.get(key)));
      const name = attributesOf(group)['name'];
      return {
        key: group.key,
        name: typeof name === 'string' ? name : group.key,
        members: members.map((member) => toPerson(member)),
      };
    }),
  );
  return json(groups);
});

async function create(permit: Permit, admin: string, body: Record<string, unknown>) {
  const name = requireText(body, 'name');
  const key = groupKey(admin, name);
  if (key === undefined) {
    throw new HttpError(
      400,
      'Use a name of up to 50 characters with at least one letter or digit.',
    );
  }
  if (!(await createGroup(permit, { key, name, admin }))) {
    throw new HttpError(409, 'You already have a group with this name.');
  }
  return json({ key, name, members: [] } satisfies MemberGroup, 201);
}

async function assign(permit: Permit, admin: string, body: Record<string, unknown>) {
  const email = requireText(body, 'email').toLowerCase();
  const key = requireText(body, 'group');
  if (!(await mayManageGroup(permit, admin, key))) {
    return denied('You are not allowed to add members to this group.');
  }
  // Permit read: api.users.list finds the member by email (the search also matches substrings).
  const { data } = await permit.api.users.list({ search: email });
  const member = data.find((candidate) => candidate.email?.toLowerCase() === email);
  if (member === undefined) throw new HttpError(404, 'No member with that email.');
  if (!(await addGroupMember(permit, key, member.key))) {
    throw new HttpError(409, 'This member is in the group already.');
  }
  return json({ success: true });
}

async function unassign(permit: Permit, admin: string, body: Record<string, unknown>) {
  const member = requireText(body, 'member');
  const key = requireText(body, 'group');
  if (!(await mayManageGroup(permit, admin, key))) {
    return denied('You are not allowed to remove members from this group.');
  }
  await removeGroupMember(permit, key, member);
  return json({ success: true });
}

/**
 * `POST /api/account/member-groups` creates a group, `.../assign` adds a member by email and
 * `.../unassign` removes one.
 */
export const POST = memberRoute<Params>(async (request, { user, params }) => {
  const action = params.action?.[0];
  if ((params.action?.length ?? 0) > 1) throw new HttpError(404, 'Unknown action.');
  const body = await readBody(request);
  const permit = getPermit();
  switch (action) {
    case undefined:
      return create(permit, user.id, body);
    case 'assign':
      return assign(permit, user.id, body);
    case 'unassign':
      return unassign(permit, user.id, body);
    default:
      throw new HttpError(404, 'Unknown action.');
  }
});

/** Deletes a group the signed-in member administers. */
export const DELETE = memberRoute<Params>(async (request, { user, params }) => {
  rejectSegments(params.action);
  const key = requireText(await readBody(request), 'key');
  const permit = getPermit();
  if (!(await mayManageGroup(permit, user.id, key))) {
    return denied('You are not allowed to delete this group.');
  }
  // Permit write: api.resourceInstances deletes the group with its role assignments and
  // relationships.
  await ignoreNotFound(() => permit.api.resourceInstances.delete(groupInstance(key)));
  return json({ success: true });
});
