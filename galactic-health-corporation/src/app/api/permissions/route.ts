import { denied, HttpError, json, memberRoute, readBody } from '@/lib/api';
import { getPermit } from '@/lib/permit';

const MAX_CHECKS = 20;

interface Query {
  action: string;
  resource: string;
}

function queries(body: Record<string, unknown>): Query[] {
  const list = body['resourcesAndActions'];
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_CHECKS) {
    throw new HttpError(400, `"resourcesAndActions" must list 1 to ${MAX_CHECKS} checks.`);
  }
  return list.map((item: unknown) => {
    const { action, resource } = (item ?? {}) as Record<string, unknown>;
    if (typeof action !== 'string' || typeof resource !== 'string' || !action || !resource) {
      throw new HttpError(400, 'Each check needs an "action" and a "resource" string.');
    }
    return { action, resource };
  });
}

/**
 * The backend of permit-fe-sdk's `loadLocalStateBulk`: answers a list of checks for the signed-in
 * member. The SDK also sends `?user=`; the session decides who is checked, and a different user is
 * refused.
 */
export const POST = memberRoute(async (request, { user }) => {
  const asked = request.nextUrl.searchParams.get('user');
  if (asked !== null && asked !== user.id) return denied('You can only check your own access.');
  const checks = queries(await readBody(request));
  // Permit check: one bulk call to the PDP for every action and resource the page asked about.
  const permittedList = await getPermit().bulkCheck(
    checks.map(({ action, resource }) => ({ user: user.id, action, resource })),
  );
  return json({ permittedList });
});
