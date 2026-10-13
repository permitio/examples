import type { Permit } from 'permitio';
import { loadSeed, type SeedData, TENANT } from '#src/server/model';
import { membersOf } from '#src/server/routes/s2';
import { ignoreNotFound, type Log, logged } from '#scripts/lib/admin';
import { demoData } from '#scripts/lib/fixtures';

/**
 * Undoes what S2 changed in Permit. Team access gives roles to every member of Shire Freight, not
 * only to Merry, so for each member it takes back every role on a single resource in shire-freight
 * that the seed does not give. Frodo's account_admin on EAN-1001 is the seed's and stays (S8
 * revokes it, and resetS8 gives it back). A member's place in the organization is a role in the
 * tenant itself (org_member, developer), which S2 never touches, so it stays too. A role that is
 * already gone (Permit's 404) is fine. reset.ts calls it once the demo data is restored.
 */
export async function resetS2(
  permit: Permit,
  log: Log,
  seed: SeedData = loadSeed(),
): Promise<void> {
  const seeded = new Set(
    demoData(seed).assignments.flatMap((a) =>
      a.resource_instance ? [`${a.user} ${a.role} ${a.resource_instance}`] : [],
    ),
  );
  let removed = 0;
  for (const { key: user } of membersOf(seed)) {
    // Permit read: the member's roles in the tenant (api.roleAssignments.list). A role on one
    // resource carries its `resource_instance`; a role in the tenant has none (absent or null on
    // the wire, so the test is for a value, not undefined).
    const assignments = await permit.api.roleAssignments.list({ user, tenant: TENANT.shire });
    for (const { role, resource_instance } of assignments) {
      if (!resource_instance || seeded.has(`${user} ${role} ${resource_instance}`)) continue;
      removed += 1;
      await logged(log, `role ${role} for ${user} on ${resource_instance} removed`, () =>
        // Permit write: the role taken off the member on that one resource
        // (api.roleAssignments.unassign).
        ignoreNotFound(() =>
          permit.api.roleAssignments.unassign({
            user,
            role,
            tenant: TENANT.shire,
            resource_instance,
          }),
        ),
      );
    }
  }
  if (removed === 0)
    await logged(log, "S2, members' roles on single resources beyond the seed", async () => 'none');
}
