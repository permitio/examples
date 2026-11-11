import type { Permit, UserRead } from 'permitio';
import { ignoreConflict, ignoreNotFound } from '@/lib/permit';
import {
  attributesOf,
  caregiverBoundsOf,
  instanceOf,
  type SharingOption,
  TENANT,
} from '@/lib/resources';

export interface Grant {
  owner: string;
  caregiver: UserRead;
  resource: SharingOption;
  startDate: string;
  endDate: string;
}

/**
 * Makes `caregiver` a caregiver of the owner's `resource` (their whole member record, health plan
 * or medical records). The date bounds are stored on the caregiver as the `caregiver_bounds` user
 * attribute, which the optional custom Rego policy (`policy/custom.rego`) enforces.
 */
export async function grantCaregiver(permit: Permit, grant: Grant): Promise<void> {
  const instance = instanceOf(grant.resource, grant.owner);
  const attributes = attributesOf(grant.caregiver);
  // Permit write: api.users.update stores the date bounds of this grant on the caregiver.
  await permit.api.users.update(grant.caregiver.key, {
    attributes: {
      ...attributes,
      caregiver_bounds: {
        ...caregiverBoundsOf(grant.caregiver),
        [instance]: { start_date: grant.startDate, end_date: grant.endDate },
      },
    },
  });
  // Permit write: api.roleAssignments gives the caregiver role on the owner's instance. From a
  // member instance it carries over to the profile, health plan and medical records (ReBAC).
  await ignoreConflict(() =>
    permit.api.roleAssignments.assign({
      user: grant.caregiver.key,
      role: 'caregiver',
      resource_instance: instance,
      tenant: TENANT,
    }),
  );
}

/** Takes back a caregiver role and its date bounds. */
export async function revokeCaregiver(
  permit: Permit,
  revoke: { owner: string; caregiver: UserRead; resource: SharingOption },
): Promise<void> {
  const instance = instanceOf(revoke.resource, revoke.owner);
  const bounds = caregiverBoundsOf(revoke.caregiver);
  delete bounds[instance];
  // Permit write: api.users.update drops the date bounds of this grant from the caregiver.
  await permit.api.users.update(revoke.caregiver.key, {
    attributes: { ...attributesOf(revoke.caregiver), caregiver_bounds: bounds },
  });
  // Permit write: api.roleAssignments removes the caregiver role on the owner's instance.
  await ignoreNotFound(() =>
    permit.api.roleAssignments.unassign({
      user: revoke.caregiver.key,
      role: 'caregiver',
      resource_instance: instance,
      tenant: TENANT,
    }),
  );
}
