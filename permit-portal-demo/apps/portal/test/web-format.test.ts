import { describe, expect, it } from 'vitest';
import {
  canChecks,
  formatCountdown,
  formatDuration,
  formatOffset,
  formatRelative,
  formatSeconds,
  parseTime,
  replayNote,
  requestDuration,
  roleWords,
  ruleLegend,
  timeLegend,
  formatPrecise,
  trustFactItems,
} from '@/format';

describe('formatCountdown', () => {
  it.each([
    [125_000, '2:05'],
    [-1, 'expired'],
    [3 * 86_400_000 + 5_000, '3d 0:00:05'],
    [3_600_000, '1:00:00'],
    [0, '0:00'],
    [124_001, '2:05'],
    [Number.NaN, '—'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('formatSeconds', () => {
  it.each([
    [600, '0.6 s'],
    [1_234, '1.2 s'],
    [5_000, '5.0 s'],
    [44.2, '0.0 s'],
    [Number.NaN, '—'],
  ])('formats a change that took %d ms as %s', (ms, text) => {
    expect(formatSeconds(ms)).toBe(text);
  });
});

describe('replayNote', () => {
  it('warns when the replayed decision differs from the recorded one', () => {
    expect(replayNote(true, false)).toBe('The data changed since this check; the reason reflects the current data.');
    expect(replayNote(false, true)).toBe('The data changed since this check; the reason reflects the current data.');
  });

  it('says nothing when the replay agrees', () => {
    expect(replayNote(true, true)).toBeUndefined();
    expect(replayNote(false, false)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it.each([
    [120_000, '2 minutes'],
    [60_000, '1 minute'],
    [3_600_000, '1 hour'],
    [7 * 86_400_000, '7 days'],
    [86_400_000, '1 day'],
    [90_500, '91 seconds'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatOffset', () => {
  it.each([
    [3_600_000, '+60 min'],
    [86_400_000, '+1440 min'],
    [-120_000, '−2 min'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatOffset(ms)).toBe(text);
  });
});

describe('parseTime', () => {
  it('reads epoch milliseconds and date strings', () => {
    expect(parseTime(1_759_759_200_000)).toBe(1_759_759_200_000);
    expect(parseTime('2026-10-06T14:00:00Z')).toBe(Date.parse('2026-10-06T14:00:00Z'));
  });

  it.each([[null], [undefined], [''], ['not a date'], [Number.NaN], [{}]])('treats %s as absent', (value) => {
    expect(parseTime(value)).toBeNull();
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-06T14:00:00Z');

  it.each([
    ['2026-10-06T13:59:30Z', 'just now'],
    ['2026-10-06T13:50:00Z', '10 min ago'],
    ['2026-10-06T11:00:00Z', '3 h ago'],
    ['2026-10-04T14:00:00Z', '2 d ago'],
    ['2026-10-06T14:00:05Z', 'just now'],
  ])('formats %s as %s', (at, text) => {
    expect(formatRelative(at, now)).toBe(text);
  });

  it('accepts epoch milliseconds', () => {
    expect(formatRelative(now - 600_000, now)).toBe('10 min ago');
  });
});

describe('requestDuration', () => {
  it('reads a grant duration in ms, or a renewal in days', () => {
    expect(requestDuration({ duration_ms: 120_000 })).toBe('2 minutes');
    expect(requestDuration({ requested_days: 7 })).toBe('7 days');
    expect(requestDuration({})).toBeUndefined();
  });
});

describe('canChecks', () => {
  it('lists every action in order, with no result for one the server did not answer', () => {
    expect(canChecks({ view: true, invite: false }, ['invite', 'view', 'step_down'])).toEqual([
      { label: 'invite', allow: false },
      { label: 'view', allow: true },
      { label: 'step_down', allow: undefined },
    ]);
  });
});

describe('trustFactItems', () => {
  it('writes each Great Eagle fact as words, failing ones included', () => {
    expect(trustFactItems({ identity_verified: false, duplicate_check: 'suspected', risk_state: 'suspended' }, true)).toEqual([
      { key: 'identity', ok: false, text: 'Identity not verified' },
      { key: 'duplicate', ok: false, text: 'Duplicate suspected' },
      { key: 'risk', ok: false, text: 'Risk suspended' },
      { key: 'ownership', ok: true, text: 'Ownership verified' },
    ]);
  });

  it('says so when Great Eagle holds no identity facts for the user', () => {
    expect(trustFactItems(null, false)).toEqual([
      { key: 'facts', ok: false, text: 'No identity facts on record' },
      { key: 'ownership', ok: false, text: 'Ownership not verified' },
    ]);
  });
});

describe('ruleLegend', () => {
  it('maps each encoded rule name in a PDP reason to its readable name, once', () => {
    const reason = {
      abac: {
        reason: "user 'aragorn' does not match any rule that grants him the 'view' permission on the given resource of type 'shipment'",
        rules: ['userset_active_5fcollaborator', 'resourceset_verified_5forganization', 'userset_active_5fcollaborator'],
      },
    };

    expect(ruleLegend(reason)).toEqual([
      { encoded: 'userset_active_5fcollaborator', readable: 'active_collaborator', kind: 'user set' },
      { encoded: 'resourceset_verified_5forganization', readable: 'verified_organization', kind: 'resource set' },
    ]);
  });

  it('reads names inside a plain-text reason', () => {
    expect(ruleLegend('allowed by userset_verified_5forg_5fadmin')).toEqual([
      { encoded: 'userset_verified_5forg_5fadmin', readable: 'verified_org_admin', kind: 'user set' },
    ]);
  });

  it('returns nothing when the reason names no rule', () => {
    expect(ruleLegend(undefined)).toEqual([]);
    expect(ruleLegend({ rbac: { allow: false } })).toEqual([]);
  });
});

describe('timeLegend', () => {
  it('lists the check time and each grant expiry, labelled by resource, once each', () => {
    const input = { user: { key: 'aragorn', attributes: { current_time: 1_791_138_463_038 } } };
    const reason = {
      request: {
        user: {
          attributes: {
            current_time: 1_791_138_463_038,
            time_based_grants: [{ resource: 'SHP-77001', role: 'collaborator', expires: 1_791_138_424_191, renewals_used: 0 }],
          },
        },
      },
    };
    expect(timeLegend([input, reason])).toEqual([
      { label: 'current_time', ms: 1_791_138_463_038 },
      { label: 'expires (SHP-77001)', ms: 1_791_138_424_191 },
    ]);
  });

  it('ignores numbers that are not epoch milliseconds and keys it does not know', () => {
    expect(timeLegend({ current_time: 7, renewals_used: 1_791_138_463_038, expires: 'soon' })).toEqual([]);
  });
});

describe('formatPrecise', () => {
  it('shows the date and the time to the millisecond', () => {
    expect(formatPrecise(1_791_138_463_038)).toMatch(/, \d{2}:\d{2}:\d{2}\.038$/);
  });
});

describe('role words', () => {
  it('describe a client as able to create and a reader as not, and show a role they do not know as it is', () => {
    expect(roleWords('integration_client')).toMatch(/create/i);
    expect(roleWords('integration_reader')).not.toMatch(/create/i);
    expect(roleWords('something_else')).toBe('something_else');
  });
});
