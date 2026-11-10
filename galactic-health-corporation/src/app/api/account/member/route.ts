import { json, memberRoute } from '@/lib/api';
import { getPermit } from '@/lib/permit';
import { TENANT, toPerson } from '@/lib/resources';

/**
 * The members of the groups the signed-in member administers: the people they can make caregivers
 * in the Delegate Permissions wizard.
 */
export const GET = memberRoute(async (_request, { user }) => {
  const permit = getPermit();
  // Permit read: api.roleAssignments lists the member groups this member is the admin of.
  const adminOf = await permit.api.roleAssignments.list({
    user: user.id,
    role: 'admin',
    tenant: TENANT,
  });
  const groups = adminOf.flatMap(({ resource_instance: instance }) =>
    instance?.startsWith('member_group:') ? [instance] : [],
  );
  // Permit read: api.roleAssignments lists each group's org_members.
  const memberships = await Promise.all(
    groups.map((group) =>
      permit.api.roleAssignments.list({ resourceInstance: group, role: 'org_member' }),
    ),
  );
  const keys = new Set(memberships.flat().map((assignment) => assignment.user));
  keys.delete(user.id);
  // Permit read: api.users.get returns each member's profile.
  const members = await Promise.all([...keys].map((key) => permit.api.users.get(key)));
  return json(members.map((member) => toPerson(member)));
});
