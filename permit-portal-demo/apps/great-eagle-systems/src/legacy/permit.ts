import { type ICheckQuery, type IResource, type IUser, Permit } from 'permitio';

/** The organization the legacy app's users and child accounts belong to. */
export const LEGACY_TENANT = 'shire-freight';

/** The legacy app's one protected action, asked of Permit on a child account. */
export const VIEW_BILLING = 'view_billing';

/**
 * The settings the legacy app's client is built from. docker-compose.yml passes them from the
 * profile.
 */
const SETTINGS = ['PERMIT_API_URL', 'PERMIT_API_KEY', 'PERMIT_PDP_URL'] as const;

/**
 * How long the PDP may take to answer a check. It is local and answers in milliseconds, so a longer
 * wait means it is not answering.
 */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * A setting the legacy app's Permit client needs is missing, so it cannot ask Permit anything. The
 * message names settings, never values.
 */
export class PermitNotConfigured extends Error {
  constructor(readonly missing: readonly string[]) {
    const names =
      missing.length === 1
        ? missing[0]
        : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
    super(`Missing ${names}: the legacy app asks Permit with its own client, from these settings`);
    this.name = 'PermitNotConfigured';
  }
}

/**
 * The role assignment the sync writes: a role in a tenant, or on one resource instance (`type:key`)
 * of it.
 */
export interface RoleWrite {
  user: string;
  role: string;
  tenant: string;
  resource_instance?: string;
}

/** The part of the Permit SDK the legacy app uses. The real `Permit` satisfies it. */
export interface LegacyPermit {
  check(user: IUser, action: string, resource: IResource): Promise<boolean>;
  bulkCheck(checks: ICheckQuery[]): Promise<boolean[]>;
  api: {
    users: {
      /** A page of the users whose key contains `search`, each with its attributes when it has any. */
      list(params: {
        search: string;
        page: number;
        perPage: number;
      }): Promise<{ data: Array<{ key: string; attributes?: Record<string, unknown> }> }>;
      waitForSync(
        timeout: number,
        policy: 'fail',
      ): { assignRole(write: RoleWrite): Promise<unknown> };
    };
    roleAssignments: {
      /**
       * A page of the roles `user` holds in `tenant`; a role on one resource carries it as
       * `resource_instance` (`type:key`).
       */
      list(params: {
        user: string;
        tenant: string;
        page: number;
        perPage: number;
      }): Promise<Array<{ role: string; resource_instance?: string | null }>>;
    };
  };
}

/**
 * One view_billing question: the user, the action, and the child account in the legacy app's
 * tenant.
 */
export interface BillingCheck {
  user: IUser;
  action: typeof VIEW_BILLING;
  resource: IResource;
}

/**
 * One view_billing question, shaped like every check in the demo: the user carries the time as
 * `current_time`, and the resource carries its own key as `id`, since rules cannot read the key
 * itself.
 */
export function viewBilling(user: string, account: string, now: number): BillingCheck {
  return {
    user: { key: user, attributes: { current_time: now } },
    action: VIEW_BILLING,
    resource: { type: 'account', key: account, tenant: LEGACY_TENANT, attributes: { id: account } },
  };
}

/**
 * The legacy app's own Permit SDK client, from PERMIT_API_URL, PERMIT_API_KEY and PERMIT_PDP_URL in
 * `env`, for its one question, asked in bulk: view_billing on account:<key> in shire-freight.
 * Throws PermitNotConfigured when a setting is missing, rather than fall back to the SDK's
 * defaults: an app without settings must never reach a real Permit.
 */
export function legacyPermit(env: NodeJS.ProcessEnv): Permit {
  const missing = SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) throw new PermitNotConfigured(missing);
  // Permit SDK: the legacy app's own client, the way an existing app adds Permit next to its own
  // logic. `token` is the environment's API key, `pdp` the local PDP that answers every check, and
  // `apiUrl` Permit's API.
  return new Permit({
    token: env['PERMIT_API_KEY'],
    apiUrl: env['PERMIT_API_URL'],
    pdp: env['PERMIT_PDP_URL'],
    // Writes go through the PDP, which answers once it has applied them: `api.users.waitForSync`
    // only waits on a client that does.
    proxyFactsViaPdp: true,
    // A PDP that cannot answer must throw. With this off the SDK answers deny for every check
    // instead, and the comparison would report "everything differs" where it should report "could
    // not check". The SDK's default is on; this keeps it so.
    throwOnError: true,
    timeout: CHECK_TIMEOUT_MS,
    log: { level: 'warn' },
  });
}
