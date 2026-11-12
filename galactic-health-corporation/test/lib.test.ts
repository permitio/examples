import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { permitApiError, permitUser } from '#test/permit-fake';
import { authSecret, ConfigError, permitSettings } from '@/lib/config';
import { healthPlanFor, medicalRecordsFor } from '@/lib/demo-data';
import { groupKey } from '@/lib/groups';
import { describePermitError, ignoreConflict, ignoreNotFound, permitStatus } from '@/lib/permit';
import { caregiverBoundsOf, isSharingOption, ownerOf, toPerson } from '@/lib/resources';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ownerOf', () => {
  it.each([
    ['member:member_rick', { type: 'member', owner: 'rick' }],
    ['health_plan:health_plan_a_b', { type: 'health_plan', owner: 'a_b' }],
  ])('reads %s', (instance, expected) => {
    expect(ownerOf(instance)).toEqual(expected);
  });

  it.each(['member', ':member_rick', 'member:profile_rick', 'member:member_', ''])(
    'rejects %j',
    (instance) => {
      expect(ownerOf(instance)).toBeUndefined();
    },
  );
});

describe('caregiverBoundsOf', () => {
  it('keeps well-formed bounds and skips malformed ones', () => {
    const user = permitUser('morty', {
      attributes: {
        caregiver_bounds: {
          'member:member_rick': { start_date: 'a', end_date: 'b' },
          'health_plan:health_plan_rick': { start_date: 7 },
          'medical_records:medical_records_rick': 'not an object',
        },
      },
    });
    expect(caregiverBoundsOf(user)).toEqual({
      'member:member_rick': { start_date: 'a', end_date: 'b' },
      'health_plan:health_plan_rick': { start_date: '', end_date: '' },
    });
  });

  it('returns no bounds for a user without the attribute', () => {
    expect(caregiverBoundsOf(permitUser('homer'))).toEqual({});
    expect(caregiverBoundsOf(permitUser('homer', { attributes: { caregiver_bounds: 3 } }))).toEqual(
      {},
    );
  });
});

describe('toPerson', () => {
  it('fills missing fields with empty strings', () => {
    const { first_name: _dropped, ...user } = permitUser('x', { attributes: { phoneNumber: 5 } });
    expect(toPerson(user)).toMatchObject({ id: 'x', firstName: '', phoneNumber: '' });
  });
});

describe('isSharingOption', () => {
  it('accepts only the three shareable resources', () => {
    expect(['member', 'health_plan', 'medical_records'].every(isSharingOption)).toBe(true);
    expect(isSharingOption('profile')).toBe(false);
    expect(isSharingOption(undefined)).toBe(false);
  });
});

describe('groupKey', () => {
  it('turns the name into a slug after the admin key', () => {
    expect(groupKey('rick', "  Rick's Org!  ")).toBe('member_group_rick_rick_s_org');
  });

  it('refuses names without letters or digits, and names over 50 characters', () => {
    expect(groupKey('rick', '---')).toBeUndefined();
    expect(groupKey('rick', 'a'.repeat(51))).toBeUndefined();
    expect(groupKey('rick', 'a'.repeat(50))).toBe(`member_group_rick_${'a'.repeat(50)}`);
  });
});

describe('demo data', () => {
  const today = new Date('2026-11-10T00:00:00Z');

  it('gives each member the same data on every call', () => {
    expect(healthPlanFor('rick', today)).toEqual(healthPlanFor('rick', today));
    expect(medicalRecordsFor('rick')).toEqual(medicalRecordsFor('rick'));
    expect(healthPlanFor('rick', today)).not.toEqual(healthPlanFor('morty', today));
  });

  it('keeps claims within the year before today and allergies distinct', () => {
    for (const key of ['rick', 'morty', 'birdperson', 'homer', 'a', 'b', 'c']) {
      for (const claim of healthPlanFor(key, today).claims) {
        const age = today.getTime() - new Date(claim.date).getTime();
        expect(age).toBeGreaterThanOrEqual(0);
        expect(age).toBeLessThanOrEqual(366 * 24 * 60 * 60 * 1000);
      }
      const { allergies } = medicalRecordsFor(key);
      expect(new Set(allergies).size).toBe(allergies.length);
    }
  });
});

describe('Permit error helpers', () => {
  it('reads the status and message of an API error', () => {
    const error = permitApiError(409, 'exists');
    expect(permitStatus(error)).toBe(409);
    expect(describePermitError(error)).toBe('exists');
    expect(permitStatus(new Error('plain'))).toBeUndefined();
    expect(describePermitError(new Error('plain'))).toBe('plain');
    expect(describePermitError('text')).toBe('text');
  });

  it('treats only the expected status as success', async () => {
    await expect(ignoreConflict(() => Promise.reject(permitApiError(409)))).resolves.toBe('exists');
    await expect(ignoreConflict(() => Promise.reject(permitApiError(500)))).rejects.toThrow();
    await expect(ignoreNotFound(() => Promise.reject(permitApiError(404)))).resolves.toBe('absent');
    await expect(ignoreNotFound(() => Promise.reject(permitApiError(409)))).rejects.toThrow();
    await expect(ignoreConflict(() => Promise.resolve())).resolves.toBe('done');
  });
});

describe('config', () => {
  it('asks for PERMIT_API_KEY when it is missing', () => {
    vi.stubEnv('PERMIT_API_KEY', '');
    expect(() => permitSettings()).toThrow(ConfigError);
    expect(() => permitSettings()).toThrow('Copy .env.example to .env');
  });

  it('defaults the API and PDP addresses', () => {
    vi.stubEnv('PERMIT_API_URL', undefined);
    vi.stubEnv('PERMIT_PDP_URL', undefined);
    expect(permitSettings()).toMatchObject({
      apiUrl: 'https://api.permit.io',
      pdp: 'http://localhost:7766',
    });
  });

  it('reads the session secret from the file setup wrote next to the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghc-config-'));
    writeFileSync(join(directory, 'auth-secret'), 'from-file\n');
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('DATABASE_PATH', join(directory, 'auth.db'));
    expect(authSecret()).toBe('from-file');
  });

  it('says to run setup when there is no session secret', () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    vi.stubEnv('DATABASE_PATH', join(tmpdir(), 'ghc-config-missing', 'auth.db'));
    expect(() => authSecret()).toThrow('Run `pnpm run setup` first');
    vi.stubEnv('DATABASE_PATH', ':memory:');
    expect(() => authSecret()).toThrow(ConfigError);
  });
});
