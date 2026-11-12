import { apiRoute, fail, ok } from '#lib/api';
import { check, listCustomers } from '#lib/authorizer';
import type { Customer } from '#lib/model';

/** GET /api/user: the customers, for the manager and for representatives. */
export default apiRoute<Customer[]>({
  GET: async ({ actor }) => {
    // Permit check (RBAC): the manager and representative roles grant `users:list`.
    if (!(await check(actor, 'list', 'users'))) {
      return fail(403, `User ${actor} is not allowed to list users`);
    }
    return ok(await listCustomers());
  },
});
