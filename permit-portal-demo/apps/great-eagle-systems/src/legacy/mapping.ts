import { readFileSync } from 'node:fs';
import type { LegacyUser, SeedAccount } from '#src/seed';

/**
 * One version of demo-data/legacy-mapping.json: the admins the owner confirmed, and the role each
 * kind of code maps to (null: none).
 */
export interface MappingVersion {
  confirmed_admins: string[];
  ean_codes: string | null;
  child_account_codes: string | null;
}
/**
 * demo-data/legacy-mapping.json: the mapping's versions, and the tightenings the domain owner
 * approved.
 */
export interface LegacyMapping {
  versions: Record<'1' | '2', MappingVersion>;
  approved_tightenings: Array<{ user: string; reason: string; approved_by: string }>;
}
/**
 * A grant the mapping writes to Permit: a tenant role when `resource` is undefined, else a role on
 * that resource (`type:key`).
 */
export interface MappedGrant {
  user: string;
  role: string;
  resource?: string;
}

/** The tenant role an admin flag maps to, for the users the owner confirmed as organization admins. */
const ORG_ADMIN = 'org_admin';

/** Reads the mapping the domain owner reviewed (demo-data/legacy-mapping.json at the repo root). */
export function loadMapping(): LegacyMapping {
  return JSON.parse(
    readFileSync(new URL('../../../../demo-data/legacy-mapping.json', import.meta.url), 'utf8'),
  ) as LegacyMapping;
}

/** The rules of one version of the mapping. */
export function versionOf(mapping: LegacyMapping, version: 1 | 2): MappingVersion {
  return version === 1 ? mapping.versions['1'] : mapping.versions['2'];
}

/**
 * The grants mapping `version` gives the legacy users, in table order: for each user, the tenant
 * role first, then one grant per code in `accounts`, in the user's order.
 *
 * - The admin flag becomes the tenant role `org_admin`, only for a user the owner confirmed. A
 *   confirmed name that is not in the table, and a confirmed user whose flag is gone, have nothing
 *   to translate.
 * - An EAN code becomes the version's EAN role on that EAN, and a child-account code its
 *   child-account role on that account, when the version has one: v1 has none, and its users with
 *   only such a code get no grant.
 * - A code that is neither an EAN nor a child account of the master is never translated.
 *
 * Whether a user exists in Permit is not decided here: writing the grants skips the ones that do
 * not.
 */
export function grantsFor(
  version: 1 | 2,
  users: LegacyUser[],
  accounts: SeedAccount[],
  mapping: LegacyMapping,
): MappedGrant[] {
  const rules = versionOf(mapping, version);
  const eans = new Set(accounts.map((a) => a.ean));
  const children = new Set(accounts.map((a) => a.key));
  return users.flatMap((user): MappedGrant[] => {
    const grants: MappedGrant[] = [];
    if (user.is_admin && rules.confirmed_admins.includes(user.key))
      grants.push({ user: user.key, role: ORG_ADMIN });
    for (const code of user.accounts) {
      if (eans.has(code)) {
        if (rules.ean_codes !== null)
          grants.push({ user: user.key, role: rules.ean_codes, resource: `ean:${code}` });
      } else if (children.has(code) && rules.child_account_codes !== null) {
        grants.push({
          user: user.key,
          role: rules.child_account_codes,
          resource: `account:${code}`,
        });
      }
    }
    return grants;
  });
}
