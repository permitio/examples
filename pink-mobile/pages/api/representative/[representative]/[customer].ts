import { PermitApiError } from 'permitio';
import { apiRoute, fail, ok, segment, type Reply, type RouteInput } from '#lib/api';
import { assignCustomer, check, isRepresentative, unassignCustomer } from '#lib/authorizer';
import { accountKeyOf } from '#lib/model';

interface Assignment {
  representative: string;
  customer: string;
}

type Operation = 'assign' | 'unassign';

function isNotFound(error: unknown): boolean {
  return error instanceof PermitApiError && error.response?.status === 404;
}

async function change(
  { actor, query }: RouteInput,
  operation: Operation,
): Promise<Reply<Assignment>> {
  const representative = segment(query, 'representative');
  const customer = segment(query, 'customer');
  const account = customer === undefined ? undefined : accountKeyOf(customer);
  if (representative === undefined || accountKeyOf(representative) === undefined) {
    return fail(400, 'The representative must be an email address');
  }
  if (customer === undefined || account === undefined) {
    return fail(400, 'The customer must be an email address');
  }

  // Permit check (RBAC): the manager role grants `representatives:assign`.
  if (!(await check(actor, 'assign', 'representatives'))) {
    return fail(403, `User ${actor} is not allowed to ${operation} representatives`);
  }
  // Only a representative gets customers, so the Manager tab, which lists representatives, shows
  // every assignment it makes. Unassigning stays open to anyone, to clean up.
  if (operation === 'assign' && !(await isRepresentative(representative))) {
    return fail(400, `${representative} is not a representative`);
  }

  try {
    // Permit write: the representative's `editor` role on the customer's account.
    await (operation === 'assign'
      ? assignCustomer(representative, account)
      : unassignCustomer(representative, account));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return operation === 'assign'
      ? fail(404, `There is no account ${account}: ${customer} is not a customer`)
      : fail(404, `${representative} is not assigned to ${customer}`);
  }
  return ok({ representative, customer });
}

/**
 * POST assigns, and DELETE unassigns, a customer to a representative: the representative becomes,
 * or stops being, an editor on the customer's account.
 */
export default apiRoute<Assignment>({
  POST: (input) => change(input, 'assign'),
  DELETE: (input) => change(input, 'unassign'),
});
