import type { Permit } from 'permitio';
import { beforeAll, describe, expect, it } from 'vitest';
import { setUpDatabase } from '#test/http';
import { permitApiError, permitFake, permitUser } from '#test/permit-fake';
import { seedDemo } from '#scripts/seed';
import { getAuth } from '@/lib/auth';
import { DEMO_PASSWORD, PERSONAS } from '@/lib/personas';

const permit = permitFake as unknown as Permit;
const NOW = new Date('2026-11-10T12:00:00.000Z');

beforeAll(setUpDatabase);

function seed() {
  return seedDemo(getAuth(), permit, () => undefined, NOW);
}

describe('seedDemo', () => {
  it('creates every persona with a fixed id that can sign in with the demo password', async () => {
    permitFake.api.users.get.mockImplementation(async (key: unknown) => {
      if (key === 'morty') return permitUser('morty');
      throw permitApiError(404);
    });

    await seed();

    for (const persona of PERSONAS) {
      expect(permitFake.api.users.sync).toHaveBeenCalledWith(
        expect.objectContaining({ key: persona.id, email: persona.email }),
      );
      const session = await getAuth().api.signInEmail({
        body: { email: persona.email, password: DEMO_PASSWORD },
      });
      expect(session.user.id).toBe(persona.id);
    }
  });

  it('writes the groups, pilot-group roles and the caregiver grant', async () => {
    permitFake.api.users.get.mockImplementation(async (key: unknown) => permitUser(String(key)));

    await seed();

    expect(permitFake.api.resourceInstances.create).toHaveBeenCalledWith({
      resource: 'member_group',
      key: 'member_group_rick_smith_family',
      tenant: 'default',
      attributes: { name: 'Smith Family' },
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'org_member',
      resource_instance: 'member_group:member_group_rick_smith_family',
      tenant: 'default',
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'birdperson',
      role: 'org_member',
      resource_instance: 'member_group:member_group_rick_ricks_org',
      tenant: 'default',
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'rick',
      role: 'benefits_pg_role',
      tenant: 'default',
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'birdperson',
      role: 'alt_medicine_pg_role',
      tenant: 'default',
    });
    expect(permitFake.api.users.update).toHaveBeenCalledWith('morty', {
      attributes: {
        caregiver_bounds: {
          'member:member_rick': {
            start_date: '2026-11-10T12:00:00.000Z',
            end_date: '2027-11-10T12:00:00.000Z',
          },
        },
      },
    });
    expect(permitFake.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'morty',
      role: 'caregiver',
      resource_instance: 'member:member_rick',
      tenant: 'default',
    });
  });

  it('runs again without errors when everything exists, keeping attributes', async () => {
    const conflict = async () => {
      throw permitApiError(409);
    };
    permitFake.api.roleAssignments.assign.mockImplementation(conflict);
    permitFake.api.relationshipTuples.create.mockImplementation(conflict);
    permitFake.api.resourceInstances.create.mockImplementation(conflict);
    permitFake.api.users.get.mockImplementation(async (key: unknown) =>
      permitUser(String(key), { attributes: { favouriteColour: 'green' } }),
    );

    await expect(seed()).resolves.toBeUndefined();

    // Existing accounts are registered again, keeping the attributes Permit already has.
    expect(permitFake.api.users.sync).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'homer',
        attributes: expect.objectContaining({
          favouriteColour: 'green',
          phoneNumber: '(555) 010-0004',
        }),
      }),
    );
  });

  it.each([
    [
      'keeps grant dates that cover now',
      '2026-10-01T00:00:00.000Z',
      '2027-10-01T00:00:00.000Z',
      true,
    ],
    [
      'renews grant dates that have ended',
      '2025-01-01T00:00:00.000Z',
      '2025-12-31T00:00:00.000Z',
      false,
    ],
  ])('%s', async (_case, start, end, kept) => {
    const bounds = { 'member:member_rick': { start_date: start, end_date: end } };
    permitFake.api.users.get.mockImplementation(async (key: unknown) =>
      permitUser(String(key), key === 'morty' ? { attributes: { caregiver_bounds: bounds } } : {}),
    );

    await seed();

    const expected = kept
      ? { start_date: start, end_date: end }
      : { start_date: '2026-11-10T12:00:00.000Z', end_date: '2027-11-10T12:00:00.000Z' };
    expect(permitFake.api.users.update).toHaveBeenCalledWith('morty', {
      attributes: { caregiver_bounds: { 'member:member_rick': expected } },
    });
  });

  it('fails with a clear error when the caregiver is missing from Permit', async () => {
    await expect(seed()).rejects.toThrow('Permit has no user morty');
  });
});
