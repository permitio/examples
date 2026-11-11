import { denied, json, memberRoute } from '@/lib/api';
import { getPermit } from '@/lib/permit';
import { instanceKey, toPerson } from '@/lib/resources';

/** A member's profile: the signed-in member's own, or `/api/account/profile/<user key>`. */
export const GET = memberRoute<{ user?: string[] }>(async (_request, { user, params }) => {
  const uid = params.user?.[0] ?? user.id;
  const permit = getPermit();
  // Permit check: read on the profile. Owners get it from their member instance; caregivers and
  // fellow group members get it through the parent and belongs relationships (ReBAC).
  const allowed = await permit.check(user.id, 'read', {
    type: 'profile',
    key: instanceKey('profile', uid),
  });
  if (!allowed) return denied();
  // Permit read: api.users.get returns the profile's name, email and attributes.
  const profile = await permit.api.users.get(uid);
  return json(toPerson(profile, uid === user.id ? 'Self' : ''));
});
