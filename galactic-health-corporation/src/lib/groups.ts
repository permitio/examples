import type { Permit } from 'permitio';
import { ignoreConflict, ignoreNotFound } from '@/lib/permit';
import { instanceOf, TENANT } from '@/lib/resources';

const GROUP_TYPE = 'member_group';
const MAX_NAME_LENGTH = 50;

/** The `type:key` form of a member group instance. */
export function groupInstance(groupKey: string): string {
  return `${GROUP_TYPE}:${groupKey}`;
}

/**
 * The key of a group an admin creates: `member_group_<admin>_<name as a slug>`, for example
 * `member_group_rick_smith_family`. Undefined when the name has no letters or digits or is too
 * long.
 */
export function groupKey(adminKey: string, name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  if (slug === '' || name.length > MAX_NAME_LENGTH) return undefined;
  return `${GROUP_TYPE}_${adminKey}_${slug}`;
}

/**
 * Creates a member group with `admin` as its admin. The group's `belongs` relationship to the
 * admin's profile lets the group's members read that profile (ReBAC). Returns false when a group
 * with this key exists already.
 */
export async function createGroup(
  permit: Permit,
  group: { key: string; name: string; admin: string },
): Promise<boolean> {
  // Permit write: api.resourceInstances creates the group, with its display name as an attribute.
  const created = await ignoreConflict(() =>
    permit.api.resourceInstances.create({
      resource: GROUP_TYPE,
      key: group.key,
      tenant: TENANT,
      attributes: { name: group.name },
    }),
  );
  await Promise.all([
    // Permit write: api.roleAssignments makes the creator the group's admin (list and assign).
    ignoreConflict(() =>
      permit.api.roleAssignments.assign({
        user: group.admin,
        role: 'admin',
        resource_instance: groupInstance(group.key),
        tenant: TENANT,
      }),
    ),
    linkProfile(permit, group.key, group.admin),
  ]);
  return created === 'done';
}

function linkProfile(permit: Permit, key: string, member: string) {
  // Permit write: api.relationshipTuples says the member's profile belongs to the group, so the
  // group's org_members get the caregiver role on it (read).
  return ignoreConflict(() =>
    permit.api.relationshipTuples.create({
      subject: groupInstance(key),
      relation: 'belongs',
      object: instanceOf('profile', member),
      tenant: TENANT,
    }),
  );
}

/** Adds a member to a group. Returns false when they were in it already. */
export async function addGroupMember(
  permit: Permit,
  key: string,
  member: string,
): Promise<boolean> {
  const [assigned] = await Promise.all([
    // Permit write: api.roleAssignments gives the member the group's org_member role.
    ignoreConflict(() =>
      permit.api.roleAssignments.assign({
        user: member,
        role: 'org_member',
        resource_instance: groupInstance(key),
        tenant: TENANT,
      }),
    ),
    linkProfile(permit, key, member),
  ]);
  return assigned === 'done';
}

/** Removes a member from a group: their org_member role and their profile's `belongs` link. */
export async function removeGroupMember(
  permit: Permit,
  key: string,
  member: string,
): Promise<void> {
  await Promise.all([
    // Permit write: api.roleAssignments removes the member's org_member role on the group.
    ignoreNotFound(() =>
      permit.api.roleAssignments.unassign({
        user: member,
        role: 'org_member',
        resource_instance: groupInstance(key),
        tenant: TENANT,
      }),
    ),
    // Permit write: api.relationshipTuples removes the link from the group to their profile.
    ignoreNotFound(() =>
      permit.api.relationshipTuples.delete({
        subject: groupInstance(key),
        relation: 'belongs',
        object: instanceOf('profile', member),
      }),
    ),
  ]);
}
