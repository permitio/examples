import { defineEventHandler, readBody } from 'h3';
import type { ApiMessage } from '#shared/types';
import { permitWrite, permitWriteOnce } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { parseRoleChange } from '#server/utils/validate';

/**
 * Grants or revokes a role in a city, creating the user in Permit when needed. This is the demo's
 * user switcher, so it has no Permit check of its own; a real app would guard it.
 */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const { user, role, tenant, isGrant, noOfRides } = parseRoleChange(
    await readBody<unknown>(event),
  );
  const { api } = permit();

  if (noOfRides === undefined) {
    // Permit write: creates the user; a 409 means the user exists already.
    await permitWriteOnce(`create user ${user}`, () => api.users.create({ key: user }), 409);
  } else {
    await permitWrite(`sync user ${user}`, () =>
      // Permit write: creates or replaces the user with the number_of_rides attribute the
      // experienced_riders user set reads (ABAC).
      api.users.sync({ key: user, attributes: { number_of_rides: noOfRides } }),
    );
  }

  if (isGrant) {
    await permitWriteOnce(
      `give ${user} the ${role} role in ${tenant}`,
      // Permit write: grants the role in this city (RBAC); a 409 means the user has it already.
      () => api.roleAssignments.assign({ user, role, tenant }),
      409,
    );
    return { message: `Role ${role} granted to ${user} in ${tenant}` };
  }
  await permitWriteOnce(
    `take the ${role} role in ${tenant} from ${user}`,
    // Permit write: revokes the role in this city; a 404 means the user did not have it.
    () => api.roleAssignments.unassign({ user, role, tenant }),
    404,
  );
  return { message: `Role ${role} revoked from ${user} in ${tenant}` };
});
