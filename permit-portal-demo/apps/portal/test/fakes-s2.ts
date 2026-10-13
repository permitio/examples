// Test doubles for S2's routes. They plug into harness() from test/fakes.ts; this file only
// imports from it.
import type { IResource, IUserPermissions } from 'permitio';
import type { SeedData } from '#src/server/model';
import type { harness } from '#test/fakes';

type H = ReturnType<typeof harness>;

/** The grant actions each resource type has. */
const GRANT_ACTIONS: Record<string, readonly string[]> = {
  ean: ['grant_shipper', 'grant_account_admin'],
  account: ['grant_account_manager'],
  location: ['grant_location_operator'],
};
/** Who holds which right: the organization admin anywhere in Shire Freight, an EAN admin inside the EAN. */
const ORG_ADMINS = ['sam'];
const EAN_ADMINS: Record<string, readonly string[]> = { frodo: ['EAN-1001'] };

/**
 * Permit's answers to S2's grant checks, as the policy gives them: the organization admin may grant every role anywhere,
 * an EAN admin only roles below their own, on their EAN and the child accounts and locations under it (so never
 * `grant_account_admin`), and anyone else nothing. A grant action asked on a type that does not have it is denied, as
 * Permit denies an action the type does not define. Anything that is not a grant is denied too: S2 asks nothing else.
 */
export function s2Policy(seed: SeedData): (user: string, action: string, resource: IResource) => boolean {
  /** The EAN a resource sits under: itself, its account's EAN, or its location's account's EAN. */
  const eanOf = (type: string, key: string | undefined): string | undefined => {
    if (type === 'ean') return key;
    if (type === 'account') return seed.accounts.find((a) => a.key === key)?.ean;
    if (type === 'location') return eanOf('account', seed.locations.find((l) => l.key === key)?.account);
    return undefined;
  };
  return (user, action, resource) => {
    if (!GRANT_ACTIONS[resource.type]?.includes(action)) return false;
    if (ORG_ADMINS.includes(user)) return true;
    return action !== 'grant_account_admin' && (EAN_ADMINS[user] ?? []).includes(eanOf(resource.type, resource.key) ?? '');
  };
}

/**
 * Makes the fake PDP decide with {@link s2Policy}, and logs every decision into the same list as Permit's writes
 * (`['check', user, action, 'type:key']`), so a test can assert that each check came before the write it guards.
 */
export function useS2Policy(h: H): void {
  const decide = s2Policy(h.seed);
  h.pdp.rule = (user, action, resource) => {
    h.permit.log.push(['check', user, action, `${resource.type}:${resource.key}`]);
    return decide(user, action, resource);
  };
}

/** Gives `user` a role on one resource (`type:key`) of Shire Freight, as if an earlier grant had been made. */
export function hold(h: H, user: string, role: string, resource: string): void {
  h.permit.roles.push({ user, role, tenant: 'shire-freight', resource_instance: resource });
}

/** The tenant's own entry of a user-permissions answer, keyed `__tenant:<tenant>` as the PDP keys it. */
export function tenantPermissions(tenant: string, roles: string[], permissions: string[] = []): IUserPermissions {
  return { [`__tenant:${tenant}`]: { tenant: { key: tenant, attributes: {} }, permissions, roles } };
}
