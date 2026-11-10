/**
 * The demo data: one account per persona in the app's database, and in Permit their member records,
 * groups, pilot-group roles and one caregiver grant. Safe to re-run: existing accounts and Permit
 * objects are kept, and the caregiver grant's dates restart from `now`.
 */
import type { Permit } from 'permitio';
import type { Log } from '#scripts/policy';
import type { Auth } from '@/lib/auth';
import { grantCaregiver } from '@/lib/caregivers';
import { addGroupMember, createGroup, groupKey } from '@/lib/groups';
import { enrollMember, findUser } from '@/lib/members';
import { DEMO_PASSWORD, type Persona, PERSONAS } from '@/lib/personas';
import { ignoreConflict } from '@/lib/permit';
import { type SharingOption, TENANT } from '@/lib/resources';

/** Member groups, by persona id: Rick administers both. */
export const GROUPS = [
  { admin: 'rick', name: 'Ricks Org', members: ['birdperson'] },
  { admin: 'rick', name: 'Smith Family', members: ['morty'] },
];

/** Pilot-group tenant roles (RBAC), by persona id. */
export const PILOT_GROUPS = [
  { user: 'rick', role: 'benefits_pg_role' },
  { user: 'birdperson', role: 'alt_medicine_pg_role' },
];

/** Morty is Rick's caregiver for his whole member record, for a year from the seed. */
export const CAREGIVERS: { owner: string; caregiver: string; resource: SharingOption }[] = [
  { owner: 'rick', caregiver: 'morty', resource: 'member' },
];

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Makes sure the persona can sign in with the demo password. Creating the account runs the sign-up
 * hook, which registers the member in Permit; an account that existed is registered here. Returns
 * the account's user id, which is also the Permit user key.
 */
async function ensureAccount(auth: Auth, permit: Permit, persona: Persona): Promise<string> {
  const context = await auth.$context;
  const found = await context.internalAdapter.findUserByEmail(persona.email, {
    includeAccounts: true,
  });
  let userId = found?.user.id;
  if (userId === undefined) {
    const user = await context.internalAdapter.createUser(
      {
        id: persona.id,
        email: persona.email,
        name: `${persona.firstName} ${persona.lastName}`,
        emailVerified: true,
        firstName: persona.firstName,
        lastName: persona.lastName,
        phoneNumber: persona.phoneNumber,
        dateOfBirth: persona.dateOfBirth,
      },
      { method: 'email-password' },
    );
    userId = user.id;
  } else {
    await enrollMember(permit, { ...persona, id: userId });
  }
  if (!found?.accounts.some((account) => account.providerId === 'credential')) {
    await context.internalAdapter.linkAccount({
      userId,
      providerId: 'credential',
      accountId: userId,
      password: await context.password.hash(DEMO_PASSWORD),
    });
  }
  return userId;
}

function idOf(ids: ReadonlyMap<string, string>, persona: string): string {
  const id = ids.get(persona);
  if (id === undefined) throw new Error(`Unknown persona "${persona}" in the seed data`);
  return id;
}

/** Creates the demo accounts and their Permit data. */
export async function seedDemo(auth: Auth, permit: Permit, log: Log, now: Date): Promise<void> {
  const ids = new Map<string, string>();
  for (const persona of PERSONAS) {
    ids.set(persona.id, await ensureAccount(auth, permit, persona));
    log(`  member  ${persona.email}`);
  }
  for (const group of GROUPS) {
    const admin = idOf(ids, group.admin);
    const key = groupKey(admin, group.name);
    if (key === undefined) throw new Error(`Invalid group name "${group.name}" in the seed data`);
    await createGroup(permit, { key, name: group.name, admin });
    for (const member of group.members) await addGroupMember(permit, key, idOf(ids, member));
    log(`  group   ${group.name} (${key})`);
  }
  for (const { user, role } of PILOT_GROUPS) {
    // Permit write: api.roleAssignments puts the persona in a pilot group (a tenant role).
    await ignoreConflict(() =>
      permit.api.roleAssignments.assign({ user: idOf(ids, user), role, tenant: TENANT }),
    );
    log(`  role    ${role} for ${user}`);
  }
  for (const grant of CAREGIVERS) {
    const caregiverKey = idOf(ids, grant.caregiver);
    const caregiver = await findUser(permit, caregiverKey);
    if (caregiver === undefined) throw new Error(`Permit has no user ${caregiverKey}`);
    await grantCaregiver(permit, {
      owner: idOf(ids, grant.owner),
      caregiver,
      resource: grant.resource,
      startDate: now.toISOString(),
      endDate: new Date(now.getTime() + YEAR_MS).toISOString(),
    });
    log(`  grant   ${grant.caregiver} cares for ${grant.owner}'s ${grant.resource}`);
  }
}
