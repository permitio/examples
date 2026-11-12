import { json, memberRoute } from '@/lib/api';
import { getPermit } from '@/lib/permit';
import { ownerOf, type Person, toPerson } from '@/lib/resources';

/**
 * The dashboards the signed-in member can open: their own, then those of the members who made them
 * a caregiver.
 */
export const GET = memberRoute(async (_request, { user }) => {
  const permit = getPermit();
  // Permit read: api.roleAssignments lists this member's caregiver roles; each one sits on another
  // member's member, health plan or medical records instance.
  const caregiverOf = await permit.api.roleAssignments.list({ user: user.id, role: 'caregiver' });
  const owners = new Set(
    caregiverOf.flatMap(({ resource_instance: instance }) => {
      const owner = instance === undefined ? undefined : ownerOf(instance)?.owner;
      return owner === undefined ? [] : [owner];
    }),
  );
  owners.delete(user.id);
  // Permit read: api.users.get returns each owner's profile.
  const others = await Promise.all([...owners].map((key) => permit.api.users.get(key)));
  const self: Person = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    dateOfBirth: user.dateOfBirth,
    relationship: 'Self',
  };
  return json([self, ...others.map((other) => toPerson(other))]);
});
