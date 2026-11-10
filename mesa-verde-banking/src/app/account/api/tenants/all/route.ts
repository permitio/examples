import { json, permitFailed, unauthorized } from '@/lib/http';
import { getPermit } from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/** Permit creates this tenant in every environment; it is not a bank account. */
const DEFAULT_TENANT = 'default';

/** Every account a transfer can go to: key and name only. */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  try {
    const tenants = await getPermit().api.tenants.list({ perPage: 100 });
    return json(
      tenants
        .filter((tenant) => tenant.key !== DEFAULT_TENANT)
        .map(({ key, name }) => ({ key, name })),
    );
  } catch (error) {
    return permitFailed('tenants/all', error);
  }
}
