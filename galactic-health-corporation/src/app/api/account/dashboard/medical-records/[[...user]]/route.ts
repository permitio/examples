import { denied, json, memberRoute } from '@/lib/api';
import { medicalRecordsFor } from '@/lib/demo-data';
import { getPermit } from '@/lib/permit';
import { instanceKey } from '@/lib/resources';

/** A member's medical records: the signed-in member's own, or `.../medical-records/<user key>`. */
export const GET = memberRoute<{ user?: string[] }>(async (_request, { user, params }) => {
  const uid = params.user?.[0] ?? user.id;
  // Permit check: read on the medical records, held by their owner and by caregivers of the
  // records or of the whole member record (ReBAC).
  const allowed = await getPermit().check(user.id, 'read', {
    type: 'medical_records',
    key: instanceKey('medical_records', uid),
  });
  if (!allowed) return denied();
  return json(medicalRecordsFor(uid));
});
