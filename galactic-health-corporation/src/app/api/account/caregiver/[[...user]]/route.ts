import type { Permit } from 'permitio';
import {
  denied,
  HttpError,
  json,
  memberRoute,
  readBody,
  rejectSegments,
  requireText,
} from '@/lib/api';
import { grantCaregiver, revokeCaregiver } from '@/lib/caregivers';
import { findUser } from '@/lib/members';
import { getPermit } from '@/lib/permit';
import {
  type Caregiver,
  caregiverBoundsOf,
  instanceKey,
  instanceOf,
  isSharingOption,
  SHARING_OPTIONS,
  type SharingOption,
  toPerson,
} from '@/lib/resources';

const MAX_GRANT_MS = 366 * 24 * 60 * 60 * 1000;

type Params = { user?: string[] };

/**
 * Only the owner of a member record manages its caregivers.
 *
 * Permit check: write on the signed-in member's own member instance (the owner role has it).
 */
function mayManageCaregivers(permit: Permit, userKey: string): Promise<boolean> {
  return permit.check(userKey, 'write', { type: 'member', key: instanceKey('member', userKey) });
}

function sharingOption(value: unknown): SharingOption {
  if (isSharingOption(value)) return value;
  throw new HttpError(400, `"resource" must be one of ${SHARING_OPTIONS.join(', ')}.`);
}

function dateBounds(body: Record<string, unknown>): { startDate: string; endDate: string } {
  const startDate = requireText(body, 'startDate');
  const endDate = requireText(body, 'endDate');
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new HttpError(400, '"startDate" and "endDate" must be ISO 8601 dates.');
  }
  if (end <= start) throw new HttpError(400, '"endDate" must be after "startDate".');
  if (end - start > MAX_GRANT_MS) throw new HttpError(400, 'Access can last one year at most.');
  return { startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString() };
}

/** The caregivers of the signed-in member, one row per shared resource. */
export const GET = memberRoute<Params>(async (_request, { user, params }) => {
  rejectSegments(params.user);
  const permit = getPermit();
  if (!(await mayManageCaregivers(permit, user.id))) return denied();
  // Permit read: api.roleAssignments lists the caregiver roles on each of this member's instances.
  const perResource = await Promise.all(
    SHARING_OPTIONS.map(async (resource) => {
      const instance = instanceOf(resource, user.id);
      const assignments = await permit.api.roleAssignments.list({
        resourceInstance: instance,
        role: 'caregiver',
      });
      return assignments.map((assignment) => ({ key: assignment.user, resource, instance }));
    }),
  );
  const rows = perResource.flat();
  const keys = [...new Set(rows.map((row) => row.key))];
  const caregivers = new Map(
    (await Promise.all(keys.map((key) => findUser(permit, key)))).flatMap((caregiver) =>
      caregiver === undefined ? [] : [[caregiver.key, caregiver] as const],
    ),
  );
  const result = rows.flatMap(({ key, resource, instance }): Caregiver[] => {
    const caregiver = caregivers.get(key);
    if (caregiver === undefined) return [];
    const bounds = caregiverBoundsOf(caregiver)[instance];
    return [
      {
        user: toPerson(caregiver),
        resource,
        startDate: bounds?.start_date ?? '',
        endDate: bounds?.end_date ?? '',
      },
    ];
  });
  return json(result);
});

/** Makes another member a caregiver of the signed-in member's data, between two dates. */
export const POST = memberRoute<Params>(async (request, { user, params }) => {
  rejectSegments(params.user);
  const body = await readBody(request);
  const caregiverKey = requireText(body, 'user');
  const resource = sharingOption(body['resource']);
  const { startDate, endDate } = dateBounds(body);
  if (caregiverKey === user.id) throw new HttpError(400, 'You already own your data.');
  const permit = getPermit();
  if (!(await mayManageCaregivers(permit, user.id))) return denied();
  const caregiver = await findUser(permit, caregiverKey);
  if (caregiver === undefined) throw new HttpError(404, 'No member with that key.');
  await grantCaregiver(permit, { owner: user.id, caregiver, resource, startDate, endDate });
  return json({ success: true });
});

/** Revokes a caregiver: `DELETE /api/account/caregiver/<caregiver key>/<resource>`. */
export const DELETE = memberRoute<Params>(async (_request, { user, params }) => {
  const [caregiverKey, resourceParam] = params.user ?? [];
  if (caregiverKey === undefined) {
    throw new HttpError(400, 'Use /api/account/caregiver/<caregiver key>/<resource>.');
  }
  const resource = sharingOption(resourceParam);
  const permit = getPermit();
  if (!(await mayManageCaregivers(permit, user.id))) return denied();
  const caregiver = await findUser(permit, caregiverKey);
  if (caregiver === undefined) throw new HttpError(404, 'No member with that key.');
  await revokeCaregiver(permit, { owner: user.id, caregiver, resource });
  return json({ success: true });
});
