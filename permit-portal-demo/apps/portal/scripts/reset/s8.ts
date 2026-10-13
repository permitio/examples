import type { Permit } from 'permitio';
import { RESOURCE, ROLE, TENANT } from '#src/server/model';
import { ensureAssignment, ignoreNotFound, type Log, logged } from '#scripts/lib/admin';

const PIPPIN = 'pippin';
const FRODO = 'frodo';
/** The account mapping v2 gives Pippin a role on, and the EAN S8 takes Frodo's admin role on. */
const HOBBITON = `${RESOURCE.account}:CA-1001-A`;
const EAN_1001 = `${RESOURCE.ean}:EAN-1001`;

/**
 * Undoes what S8 changed in Permit: the role its mapping wrote (Pippin's account_manager on CA-1001-A) goes,
 * and Frodo's account_admin on EAN-1001, which S8 revokes, comes back. Great Eagle's systems put the legacy app back in
 * shadow mode with the first mapping in their own reset. reset.ts calls it once the demo data is restored.
 * Each role is looked up first and written only when it needs to be, so a clean reset writes nothing, and the SDK
 * logs no 404 or 409 as an error. A 404 on the unassign and a 409 on the assign still count as done, for a role
 * that changed in between.
 */
export async function resetS8(permit: Permit, log: Log): Promise<void> {
  const { users, roleAssignments } = permit.api;

  await logged(log, `S8, ${ROLE.accountManager} on ${HOBBITON} taken from ${PIPPIN}`, async () => {
    const held = await roleAssignments.list({ user: PIPPIN, role: ROLE.accountManager, tenant: TENANT.shire });
    if (!held.some((a) => a.resource_instance === HOBBITON)) return 'absent';
    // Permit write: the mapped role removed (api.users.unassignRole with resource_instance); a 404 means it is gone already.
    const removed = await ignoreNotFound(() => users.unassignRole({ user: PIPPIN, role: ROLE.accountManager, tenant: TENANT.shire, resource_instance: HOBBITON }));
    return removed === 'done' ? 'removed' : 'absent';
  });

  await logged(log, `S8, ${ROLE.accountAdmin} on ${EAN_1001} given back to ${FRODO}`, async () => {
    const held = await roleAssignments.list({ user: FRODO, role: ROLE.accountAdmin, tenant: TENANT.shire });
    if (held.some((a) => a.resource_instance === EAN_1001)) return 'exists';
    // Permit write: the role Frodo held before S8 revoked it (api.users.assignRole with resource_instance); a 409 means it is back already.
    return ensureAssignment(permit, { user: FRODO, role: ROLE.accountAdmin, tenant: TENANT.shire, resource_instance: EAN_1001 });
  });
}
