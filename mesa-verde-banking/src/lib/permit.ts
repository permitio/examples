import { ApiKeyLevel, Permit, type TenantRead, type UserRead } from 'permitio';
import { z } from 'zod';
import { ACCOUNT_ROLES, accountKeyFor, type AccountRole } from '@/lib/accounts';
import type { Account, TransactionRow } from '@/lib/api-types';
import { permitSettings } from '@/lib/env';

let client: Permit | undefined;

/** The Permit SDK client: checks go to the PDP, data and schema calls to the Permit API. */
export function getPermit(): Permit {
  if (client === undefined) {
    const { apiKey, apiUrl, pdpUrl } = permitSettings();
    client = new Permit({ token: apiKey, apiUrl, pdp: pdpUrl });
  }
  return client;
}

/** The HTTP status of a failed Permit API call, if the error carries one. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const { response } = error;
  if (typeof response !== 'object' || response === null || !('status' in response)) {
    return undefined;
  }
  return typeof response.status === 'number' ? response.status : undefined;
}

/** Runs a create call, treating "already exists" (409) as done. */
async function createOrKeep(create: () => Promise<unknown>): Promise<void> {
  try {
    await create();
  } catch (error) {
    if (statusOf(error) !== 409) throw error;
  }
}

/** A wire transfer as the app sends it to Permit: the resource attributes of main.tf, plus `to`. */
export interface Transfer {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  /** The receiving account. */
  to: string;
}

/** The user who owns an account (holds AccountOwner in that tenant), if there is one. */
export async function getAccountOwner(tenant: string): Promise<UserRead | undefined> {
  const users = await getPermit().api.tenants.listTenantUsers({
    tenantKey: tenant,
    role: 'AccountOwner',
  });
  return users.data[0];
}

/** A Permit user by key, or undefined when Permit has no such user. */
export async function findUser(key: string): Promise<UserRead | undefined> {
  try {
    return await getPermit().api.users.get(key);
  } catch (error) {
    if (statusOf(error) === 404) return undefined;
    throw error;
  }
}

/**
 * Opens a new user's own account: a tenant named after them, the user (with the country of their
 * registered address, when the bank knows it), and the AccountOwner role in that tenant.
 */
export async function openAccount(email: string, country: string | undefined): Promise<void> {
  const permit = getPermit();
  const tenant = accountKeyFor(email);
  try {
    // Permit write: the user's account, a tenant
    await permit.api.tenants.create({ key: tenant, name: email });
  } catch (error) {
    if (statusOf(error) !== 409) throw error;
    const owner = await getAccountOwner(tenant);
    if (owner !== undefined && owner.key !== email) {
      throw new Error(`The account ${tenant} already belongs to another user`);
    }
  }
  // Permit write: the user, with their registered country
  await permit.api.users.sync({
    key: email,
    email,
    ...(country === undefined ? {} : { attributes: { country } }),
  });
  await createOrKeep(() =>
    // Permit write: AccountOwner of their account
    permit.api.roleAssignments.assign({ role: 'AccountOwner', tenant, user: email }),
  );
}

function accountRole(roles: readonly string[]): AccountRole | undefined {
  return ACCOUNT_ROLES.find((role) => roles.includes(role));
}

/** The accounts a user holds an account role in, the one they own first. */
export async function listAccounts(user: UserRead): Promise<Account[]> {
  const memberships = (user.associated_tenants ?? []).flatMap((association) => {
    const role = accountRole(association.roles);
    return role === undefined ? [] : [{ tenant: association.tenant, role }];
  });
  const tenants: TenantRead[] = await Promise.all(
    memberships.map(({ tenant }) => getPermit().api.tenants.get(tenant)),
  );
  return memberships
    .map(({ role }, index) => {
      const tenant = tenants[index];
      return { key: tenant?.key ?? '', name: tenant?.name ?? '', role };
    })
    .toSorted((a, b) => ACCOUNT_ROLES.indexOf(a.role) - ACCOUNT_ROLES.indexOf(b.role));
}

/**
 * Starts Permit's operation approval for a transfer the user may not make: a Wire_Transfer
 * instance, with the account owner as its `_Reviewer_`. The Operation Approval element then lets
 * the user ask for approval, and the owner approves it in Approval Management.
 */
export async function requestWireApproval(
  transfer: Transfer,
  tenant: string,
  ownerKey: string,
): Promise<void> {
  const permit = getPermit();
  // Permit write: the pending transfer, and the owner as its reviewer
  await permit.api.resourceInstances.create({
    resource: 'Wire_Transfer',
    key: transfer.id,
    tenant,
    attributes: { ...transfer },
  });
  await permit.api.roleAssignments.assign({
    role: '_Reviewer_',
    tenant,
    resource_instance: `Wire_Transfer:${transfer.id}`,
    user: ownerKey,
  });
}

/**
 * Records a completed transfer in Permit's relationship graph: a Transaction instance in the
 * sending account, with the sender as its `Sender` and the receiving account's owner as its
 * `Receiver`.
 */
export async function recordTransaction(
  transfer: Transfer,
  tenant: string,
  senderKey: string,
): Promise<void> {
  const permit = getPermit();
  const [receiver] = await Promise.all([
    getAccountOwner(transfer.to),
    // Permit write: the transaction, then its Sender and Receiver relationships
    permit.api.resourceInstances.create({
      resource: 'Transaction',
      key: transfer.id,
      tenant,
      attributes: { ...transfer },
    }),
  ]);
  const instance = `Transaction:${transfer.id}`;
  const assignments = [{ role: 'Sender', user: senderKey }];
  if (receiver !== undefined) assignments.push({ role: 'Receiver', user: receiver.key });
  await Promise.all(
    assignments.map(({ role, user }) =>
      permit.api.roleAssignments.assign({ role, tenant, resource_instance: instance, user }),
    ),
  );
}

const transactionAttributes = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
});

/**
 * The transactions of an account, newest first: the Transaction instances its owner holds a
 * relationship (Sender or Receiver) with in that tenant, read from the PDP.
 */
export async function listTransactions(tenant: string): Promise<TransactionRow[]> {
  const owner = await getAccountOwner(tenant);
  if (owner === undefined) return [];
  // Permit check: the Transaction instances the owner has a relationship with
  const permissions = await getPermit().getUserPermissions(
    owner.key,
    [tenant],
    [],
    ['Transaction'],
  );
  return Object.values(permissions)
    .flatMap((entry) => {
      if (!('resource' in entry) || entry.resource?.type !== 'Transaction') return [];
      const attributes = transactionAttributes.safeParse(entry.resource.attributes);
      if (!attributes.success) return [];
      const direction = entry.roles?.includes('Sender') === true ? 'out' : 'in';
      return [{ ...attributes.data, direction } satisfies TransactionRow];
    })
    .toSorted((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/** One check of the bulk frontend-permissions call. */
export interface PermissionQuery {
  action: string;
  resource: string;
  resourceAttributes: Record<string, unknown>;
}

/** Answers several checks for one user in one account, in one call to the PDP. */
export function checkAll(
  user: string,
  tenant: string,
  queries: readonly PermissionQuery[],
): Promise<boolean[]> {
  // Permit check: one decision per UI feature
  return getPermit().bulkCheck(
    queries.map(({ action, resource, resourceAttributes }) => {
      const [type = resource, key] = resource.split(':');
      return {
        user,
        action,
        resource: {
          type,
          tenant,
          attributes: resourceAttributes,
          ...(key === undefined ? {} : { key }),
        },
      };
    }),
  );
}

let environmentId: Promise<string> | undefined;

/** The id of the environment the API key belongs to; the Elements iframes need it. */
export function getEnvironmentId(): Promise<string> {
  environmentId ??= (async () => {
    const permit = getPermit();
    await permit.api.ensureAccessLevel(ApiKeyLevel.ENVIRONMENT_LEVEL_API_KEY);
    const id = permit.config.apiContext.environment;
    if (id === null) throw new Error('The Permit API key is not an environment-level key');
    return id;
  })().catch((error: unknown) => {
    environmentId = undefined;
    throw error;
  });
  return environmentId;
}
