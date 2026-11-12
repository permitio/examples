import { denied, json, memberRoute } from '@/lib/api';
import { healthPlanFor } from '@/lib/demo-data';
import { getPermit } from '@/lib/permit';
import { instanceKey } from '@/lib/resources';

/** A member's health plan: the signed-in member's own, or `.../health-plan/<user key>`. */
export const GET = memberRoute<{ user?: string[] }>(async (_request, { user, params }) => {
  const uid = params.user?.[0] ?? user.id;
  // Permit check: read on the health plan, held by its owner and by caregivers of the plan or of
  // the whole member record (ReBAC).
  const allowed = await getPermit().check(user.id, 'read', {
    type: 'health_plan',
    key: instanceKey('health_plan', uid),
  });
  if (!allowed) return denied();
  return json(healthPlanFor(uid));
});
