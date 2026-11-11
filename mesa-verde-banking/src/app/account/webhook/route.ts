import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { webhookSecret } from '@/lib/env';
import { badRequest, json, permitFailed, readJson } from '@/lib/http';
import { getPermit, recordTransaction, type Transfer } from '@/lib/permit';

/** What Permit sends when the owner approves or denies a wire transfer in Approval Management. */
const approvalEvent = z.object({
  status: z.string(),
  reviewer_user_id: z.string().min(1),
  requesting_user_id: z.string().min(1),
  operation_approval_details: z.object({
    tenant: z.string().min(1),
    resource_instance: z.string().min(1),
  }),
});

const transferAttributes = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  to: z.string(),
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Whether the request carries `Authorization: Bearer <secret>`, compared in constant time. */
function isAuthorized(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(token), digest(secret));
}

/**
 * Permit's operation approval webhook. Setup registers it only when PUBLIC_URL is set; without it,
 * approvals still happen in the Elements but the app never hears of them.
 *
 * Approved: the transfer becomes a Transaction, sent by the approver and described with who made
 * and who approved it. Denied: the pending Wire_Transfer instance is deleted.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = webhookSecret();
  if (secret === undefined) return json({ error: 'The approval webhook is not set up' }, 404);
  if (!isAuthorized(request, secret)) return json({ error: 'Unauthorized' }, 401);
  const event = approvalEvent.safeParse(await readJson(request));
  if (!event.success) return badRequest('Not an operation approval event');
  const {
    status,
    reviewer_user_id: reviewerId,
    requesting_user_id: requesterId,
    operation_approval_details: { tenant, resource_instance: instanceId },
  } = event.data;

  const permit = getPermit();
  try {
    if (status !== 'approved') {
      // Permit write: the denied transfer is no longer pending
      await permit.api.resourceInstances.delete(instanceId);
      return json({ ok: true });
    }
    const [instance, approver, requester] = await Promise.all([
      permit.api.resourceInstances.getById(instanceId),
      permit.api.users.getById(reviewerId),
      permit.api.users.getById(requesterId),
    ]);
    const attributes = transferAttributes.safeParse(instance.attributes);
    if (!attributes.success) return badRequest('The wire transfer has no transfer attributes');
    const transfer: Transfer = {
      ...attributes.data,
      description:
        `${attributes.data.description} | Made by: ${requester.email ?? requester.key}` +
        ` | Approved by: ${approver.email ?? approver.key}`,
    };
    await recordTransaction(transfer, tenant, approver.key);
    return json({ ok: true });
  } catch (error) {
    return permitFailed('webhook', error);
  }
}
