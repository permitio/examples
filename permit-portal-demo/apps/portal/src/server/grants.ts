import type { CollaboratorGrant, UserAttributes } from '#src/server/model';

const DAY_MS = 86_400_000;
const list = (a: UserAttributes) => a.time_based_grants ?? [];

export function upsertGrant(a: UserAttributes, grant: CollaboratorGrant): UserAttributes {
  return {
    ...a,
    time_based_grants: [...list(a).filter((x) => x.resource !== grant.resource), grant],
  };
}

export function renewGrant(
  a: UserAttributes,
  resource: string,
  days: number,
  now: number,
): UserAttributes {
  const cur = list(a).find((x) => x.resource === resource);
  if (!cur) throw new Error(`No grant for ${resource} to renew`);
  return upsertGrant(a, {
    ...cur,
    expires: Math.max(now, cur.expires) + days * DAY_MS,
    renewals_used: cur.renewals_used + 1,
  });
}

export function removeGrant(a: UserAttributes, resource: string): UserAttributes {
  return { ...a, time_based_grants: list(a).filter((x) => x.resource !== resource) };
}

// The `>=` / `<` boundary matches the policy's `expires greater-than-equals current_time`.
export function removeExpired(
  a: UserAttributes,
  now: number,
): { attrs: UserAttributes; removed: CollaboratorGrant[] } {
  const removed = list(a).filter((x) => x.expires < now);
  return { attrs: { ...a, time_based_grants: list(a).filter((x) => x.expires >= now) }, removed };
}

function isGrant(x: unknown): x is CollaboratorGrant {
  if (typeof x !== 'object' || x === null) return false;
  const g = x as Record<string, unknown>;
  return (
    typeof g['resource'] === 'string' &&
    g['role'] === 'collaborator' &&
    typeof g['expires'] === 'number' &&
    typeof g['renewals_used'] === 'number'
  );
}

/** The grant entries in a user's stored attributes, as Permit returns them (an untyped object). */
export function grantsOf(attributes: object | null | undefined): CollaboratorGrant[] {
  const grants: unknown = attributes
    ? (attributes as { time_based_grants?: unknown }).time_based_grants
    : undefined;
  return Array.isArray(grants) ? grants.filter(isGrant) : [];
}
