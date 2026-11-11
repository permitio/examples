import { apiRoute, fail, ok, segment } from '#lib/api';
import { check, getCustomer } from '#lib/authorizer';
import { accountKeyOf, type AccountView } from '#lib/model';

/** GET /api/account/:customer: the customer's plan, for a representative who may view it. */
export default apiRoute<AccountView>({
  GET: async ({ actor, query }) => {
    const customer = segment(query, 'id');
    const account = customer === undefined ? undefined : accountKeyOf(customer);
    if (customer === undefined || account === undefined) {
      return fail(400, 'The customer must be an email address');
    }

    const [isOwner, mayView] = await Promise.all([
      // Permit check (ReBAC): only an account's owner has `manage` on it.
      check(customer, 'manage', `account:${account}`),
      // Permit check (ReBAC): a representative views the accounts they are an editor on.
      check(actor, 'view', `account:${account}`),
    ]);
    if (!isOwner) {
      return fail(403, `User ${customer} is not an account owner`);
    }
    if (!mayView) {
      return fail(403, `User ${actor} is not authorized to view account ${account}`);
    }

    const { plan } = await getCustomer(customer);
    return ok({ plan });
  },
});
