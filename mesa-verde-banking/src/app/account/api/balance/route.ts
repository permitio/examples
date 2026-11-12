import { CURRENCY, demoBalance } from '@/lib/accounts';
import { badRequest, forbidden, json, permitFailed, tenantParam, unauthorized } from '@/lib/http';
import { getPermit } from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/** An account's balance, for users who may `read` the Account in that tenant. */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  const tenant = tenantParam(request);
  if (tenant === undefined) return badRequest('Pass the account as ?tenant=<key>');
  try {
    // Permit check: may the user read this account?
    const allowed = await getPermit().check(user.email, 'read', { type: 'Account', tenant });
    if (!allowed) return forbidden();
    return json({ balance: demoBalance(tenant), currency: CURRENCY });
  } catch (error) {
    return permitFailed('balance', error);
  }
}
