import { apiRoute, fail, ok } from '#lib/api';
import { check, listRepresentatives } from '#lib/authorizer';
import type { Representative } from '#lib/model';

/** GET /api/representative: the representatives and the customers assigned to each. */
export default apiRoute<Representative[]>({
  GET: async ({ actor }) => {
    // Permit check (RBAC): the manager role grants `representatives:list`.
    if (!(await check(actor, 'list', 'representatives'))) {
      return fail(403, `User ${actor} is not allowed to list representatives`);
    }
    return ok(await listRepresentatives());
  },
});
