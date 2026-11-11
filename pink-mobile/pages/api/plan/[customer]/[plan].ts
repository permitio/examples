import { apiRoute, fail, ok, segment } from '#lib/api';
import { check, setPlan } from '#lib/authorizer';
import { PLANS, accountKeyOf, isPlan, type Plan } from '#lib/model';

/**
 * POST /api/plan/:customer/:plan: moves the customer to the plan. Only an account owner's plan
 * changes: the owner may change it, and so may a representative who is an editor on the account,
 * unless the customer is blocked.
 */
export default apiRoute<{ plan: Plan }>({
  POST: async ({ actor, query }) => {
    const customer = segment(query, 'customer');
    const plan = segment(query, 'plan');
    const account = customer === undefined ? undefined : accountKeyOf(customer);
    if (customer === undefined || account === undefined) {
      return fail(400, 'The customer must be an email address');
    }
    if (!isPlan(plan)) {
      return fail(400, `The plan must be one of: ${PLANS.join(', ')}`);
    }

    // Permit check (ReBAC): only an account's owner has `manage` on it.
    const ownerCheck = check(customer, 'manage', `account:${account}`);
    // Permit check (ReBAC): a representative needs `plan#editor`, which `account#editor` derives
    // through `parent`. A customer acting for themselves needs only to own the account.
    const editorCheck = actor === customer ? ownerCheck : check(actor, 'change', `plan:${account}`);
    // Permit check (ABAC): `owned_plans` lets active users change the plans they own, and blocked
    // users only view them, so asking for the customer tells whether their account is blocked.
    const activeCheck = check(customer, 'change', {
      type: 'plan',
      attributes: { owner: customer },
    });
    const [isOwner, mayChange, isActive] = await Promise.all([
      ownerCheck,
      editorCheck,
      activeCheck,
    ]);
    if (!isOwner) {
      return fail(403, `User ${customer} is not an account owner`);
    }
    if (!mayChange) {
      return fail(403, `User ${actor} is not allowed to change plan for ${customer}`);
    }
    if (!isActive) {
      return fail(403, `You can't change plan for ${customer} as their account is blocked`);
    }

    // Permit write: the plan is a user attribute in Permit.
    await setPlan(customer, plan);
    return ok({ plan });
  },
});
