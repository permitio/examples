import { badRequest, permitFailed, tenantParam, unauthorized } from '@/lib/http';
import { getPermit } from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/**
 * The login URL of permit-js's cookie login: permit-js opens it in a hidden iframe, with the
 * account as `?tenant=`. The route asks Permit for a login for the signed-in user in that account
 * and redirects there; Permit sets the Elements session cookie and answers permit-js.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  const tenant = tenantParam(request);
  if (tenant === undefined) return badRequest('Pass the account as ?tenant=<key>');
  try {
    // Permit write: an Elements login for the user in this account
    const login = await getPermit().elements.loginAs({ userId: user.email, tenantId: tenant });
    return Response.redirect(login.redirect_url, 302);
  } catch (error) {
    return permitFailed('elements-login', error);
  }
}
