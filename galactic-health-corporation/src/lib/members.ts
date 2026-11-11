import type { Permit, UserRead } from 'permitio';
import { ignoreConflict, permitStatus } from '@/lib/permit';
import { attributesOf, instanceOf, TENANT } from '@/lib/resources';

/** What Permit needs to know about a member. */
export interface MemberProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  dateOfBirth: string;
}

/** A Permit user by key, or undefined when Permit has no such user. */
export async function findUser(permit: Permit, key: string): Promise<UserRead | undefined> {
  try {
    // Permit read: api.users.get returns the user with their attributes.
    return await permit.api.users.get(key);
  } catch (error) {
    if (permitStatus(error) === 404) return undefined;
    throw error;
  }
}

/**
 * Registers a member in Permit: the user with their profile attributes, the owner role on their
 * `member` instance, and the `parent` relationships that pass that role on to their profile, health
 * plan and medical records (ReBAC). Safe to repeat: other attributes (such as caregiver bounds),
 * assignments and relationships are kept.
 */
export async function enrollMember(permit: Permit, member: MemberProfile): Promise<void> {
  const existing = await findUser(permit, member.id);
  // Permit write: api.users.sync creates the user, or replaces its name, email and attributes.
  await permit.api.users.sync({
    key: member.id,
    email: member.email,
    first_name: member.firstName,
    last_name: member.lastName,
    attributes: {
      ...(existing === undefined ? {} : attributesOf(existing)),
      phoneNumber: member.phoneNumber,
      dateOfBirth: member.dateOfBirth,
    },
  });
  const memberInstance = instanceOf('member', member.id);
  // Permit write: api.roleAssignments makes the member the owner of their own member instance.
  await ignoreConflict(() =>
    permit.api.roleAssignments.assign({
      user: member.id,
      role: 'owner',
      resource_instance: memberInstance,
      tenant: TENANT,
    }),
  );
  // Permit write: api.relationshipTuples links the member instance to the member's data as its
  // parent, so the owner and caregiver roles on it carry over.
  await Promise.all(
    (['profile', 'health_plan', 'medical_records'] as const).map((type) =>
      ignoreConflict(() =>
        permit.api.relationshipTuples.create({
          subject: memberInstance,
          relation: 'parent',
          object: instanceOf(type, member.id),
          tenant: TENANT,
        }),
      ),
    ),
  );
}
