import { describe, expect, it } from 'vitest';
import { grantsOf, removeExpired, removeGrant, renewGrant, upsertGrant } from '#src/server/grants';

const DAY = 86_400_000;
const g = (resource: string, expires: number, renewals_used = 0) => ({
  resource,
  role: 'collaborator' as const,
  expires,
  renewals_used,
});

describe('grants', () => {
  it('upsert replaces the entry for the same shipment and keeps other attributes', () => {
    const a = upsertGrant(
      { risk_state: 'ok', time_based_grants: [g('SHP-1', 10)] },
      g('SHP-1', 20),
    );
    expect(a).toEqual({ risk_state: 'ok', time_based_grants: [g('SHP-1', 20)] });
  });
  it('renew extends from the later of now and the current expiry and counts the renewal', () => {
    expect(
      renewGrant({ time_based_grants: [g('SHP-1', 1_000)] }, 'SHP-1', 7, 5_000).time_based_grants,
    ).toEqual([g('SHP-1', 5_000 + 7 * DAY, 1)]);
    expect(
      renewGrant({ time_based_grants: [g('SHP-1', 9_000, 1)] }, 'SHP-1', 7, 5_000)
        .time_based_grants,
    ).toEqual([g('SHP-1', 9_000 + 7 * DAY, 2)]);
  });
  it('renew without a grant throws', () => {
    expect(() => renewGrant({}, 'SHP-1', 7, 0)).toThrow(/No grant/);
  });
  it('remove drops only that shipment', () => {
    expect(
      removeGrant({ time_based_grants: [g('SHP-1', 1), g('SHP-2', 1)] }, 'SHP-1').time_based_grants,
    ).toEqual([g('SHP-2', 1)]);
  });
  it('removeExpired keeps a grant whose expiry equals now', () => {
    const r = removeExpired({ time_based_grants: [g('A', 99), g('B', 100)] }, 100);
    expect(r.removed).toEqual([g('A', 99)]);
    expect(r.attrs.time_based_grants).toEqual([g('B', 100)]);
  });
  it('grantsOf reads well-formed entries from stored attributes and ignores anything else', () => {
    expect(grantsOf({ time_based_grants: [g('SHP-1', 5), { resource: 'SHP-2' }, 'junk'] })).toEqual(
      [g('SHP-1', 5)],
    );
    expect(grantsOf({ risk_state: 'ok' })).toEqual([]);
    expect(grantsOf(null)).toEqual([]);
    expect(grantsOf(undefined)).toEqual([]);
  });
});
