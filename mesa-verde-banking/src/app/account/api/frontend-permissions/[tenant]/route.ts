import { z } from 'zod';
import { badRequest, json, keySchema, permitFailed, readJson, unauthorized } from '@/lib/http';
import { checkAll } from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/**
 * permit-fe-sdk's bulk check request. The SDK also sends `userAttributes` and `?user=`; the route
 * ignores both and checks the signed-in user as Permit knows them, so the browser cannot claim
 * attributes it does not have.
 */
const bulkCheckRequest = z.object({
  resourcesAndActions: z
    .array(
      z.object({
        action: z.string().min(1).max(100),
        resource: z.string().min(1).max(300),
        resourceAttributes: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .min(1)
    .max(20),
});

/** Which UI features to show: one decision per action, for the account in the path. */
export async function POST(
  request: Request,
  context: { params: Promise<{ tenant: string }> },
): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  const tenant = keySchema.safeParse((await context.params).tenant);
  if (!tenant.success) return badRequest('The account key in the path is not valid');
  const body = bulkCheckRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest('Send { resourcesAndActions: [{ action, resource }] }');
  try {
    const permittedList = await checkAll(user.email, tenant.data, body.data.resourcesAndActions);
    return json({ permittedList });
  } catch (error) {
    return permitFailed('frontend-permissions', error);
  }
}
