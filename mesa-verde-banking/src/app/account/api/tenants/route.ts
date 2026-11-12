import { findCustomer } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import { json, permitFailed, unauthorized } from '@/lib/http';
import { findUser, listAccounts, openAccount, ownsOwnAccount } from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/**
 * The accounts the signed-in user can open. On a user's first visit, or until they own their own
 * account (a visit that failed half way), it also opens that account in Permit (tenant, user,
 * AccountOwner role): multi-tenant RBAC, self-service.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  try {
    let permitUser = await findUser(user.email);
    if (!ownsOwnAccount(permitUser, user.email)) {
      const customer = findCustomer(getDatabase(), user.email);
      await openAccount(user.email, customer?.country);
      permitUser = await findUser(user.email);
    }
    return json(permitUser === undefined ? [] : await listAccounts(permitUser));
  } catch (error) {
    return permitFailed('tenants', error);
  }
}
