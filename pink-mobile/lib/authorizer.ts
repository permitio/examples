import { PermitApiError, type IResource, type RoleAssignmentRead, type UserRead } from 'permitio';
import {
  TENANT,
  fullName,
  isPlan,
  type Customer,
  type Person,
  type Plan,
  type Representative,
} from '#lib/model';
import { permit } from '#lib/permit';

const ACCOUNT_PREFIX = 'account:';

/** Asks the PDP whether `user` may do `action` on `resource`. */
export function check(
  user: string,
  action: string,
  resource: string | IResource,
): Promise<boolean> {
  return permit().check(user, action, resource);
}

function attributesOf(user: UserRead): Record<string, unknown> {
  return Object.fromEntries(Object.entries(user.attributes ?? {}));
}

function toPerson(user: UserRead): Person {
  return {
    key: user.key,
    email: user.email ?? user.key,
    firstName: user.first_name ?? '',
    lastName: user.last_name ?? '',
  };
}

function toCustomer(user: UserRead): Customer {
  const attributes = attributesOf(user);
  const plan = attributes['plan'];
  return {
    ...toPerson(user),
    plan: isPlan(plan) ? plan : null,
    blocked: attributes['blocked'] === true,
  };
}

const byName = (a: Person, b: Person) => fullName(a).localeCompare(fullName(b));

/** The account key of a role assignment on `account:<key>`, or `undefined` for any other scope. */
function accountOf(assignment: RoleAssignmentRead): string | undefined {
  const instance = assignment.resource_instance;
  return instance?.startsWith(ACCOUNT_PREFIX) ? instance.slice(ACCOUNT_PREFIX.length) : undefined;
}

function listAssignments(role: string): Promise<RoleAssignmentRead[]> {
  return permit().api.roleAssignments.list({ role, tenant: TENANT, perPage: 100 });
}

async function readUsers(keys: Iterable<string>): Promise<Map<string, UserRead>> {
  const users = await Promise.all([...new Set(keys)].map((key) => permit().api.users.get(key)));
  return new Map(users.map((user) => [user.key, user]));
}

function lookup(users: Map<string, UserRead>, key: string): UserRead {
  const user = users.get(key);
  if (user === undefined) throw new Error(`Permit did not return user ${key}`);
  return user;
}

/** Everyone who owns an account or is a member of one, with their plan. */
export async function listCustomers(): Promise<Customer[]> {
  const [owners, members] = await Promise.all([
    listAssignments('owner'),
    listAssignments('member'),
  ]);
  const keys = [...owners, ...members].filter((a) => accountOf(a) !== undefined).map((a) => a.user);
  const users = await readUsers(keys);
  return [...users.values()].map(toCustomer).toSorted(byName);
}

/**
 * Every user with the `representative` role, each with the owners of the accounts they are an
 * `editor` on. Three role-assignment lists, read in parallel, give the whole picture.
 */
export async function listRepresentatives(): Promise<Representative[]> {
  const [representatives, editors, owners] = await Promise.all([
    listAssignments('representative'),
    listAssignments('editor'),
    listAssignments('owner'),
  ]);

  const ownersByAccount = new Map<string, string[]>();
  for (const owner of owners) {
    const account = accountOf(owner);
    if (account === undefined) continue;
    ownersByAccount.set(account, [...(ownersByAccount.get(account) ?? []), owner.user]);
  }

  const customersByRepresentative = new Map<string, Set<string>>();
  for (const representative of representatives) {
    if (representative.resource_instance == null) {
      customersByRepresentative.set(representative.user, new Set());
    }
  }
  for (const editor of editors) {
    const customers = customersByRepresentative.get(editor.user);
    const account = accountOf(editor);
    if (customers === undefined || account === undefined) continue;
    for (const owner of ownersByAccount.get(account) ?? []) customers.add(owner);
  }

  const users = await readUsers([
    ...customersByRepresentative.keys(),
    ...[...customersByRepresentative.values()].flatMap((customers) => [...customers]),
  ]);
  return [...customersByRepresentative]
    .map(([key, customers]) => ({
      ...toPerson(lookup(users, key)),
      customers: [...customers]
        .map((customer) => toPerson(lookup(users, customer)))
        .toSorted(byName),
    }))
    .toSorted(byName);
}

/** Whether `user` has the tenant-wide `representative` role; `false` for a user Permit lacks. */
export async function isRepresentative(user: string): Promise<boolean> {
  try {
    const roles = await permit().api.roleAssignments.list({
      user,
      role: 'representative',
      tenant: TENANT,
      perPage: 100,
    });
    return roles.some((assignment) => assignment.resource_instance == null);
  } catch (error) {
    if (error instanceof PermitApiError && error.response?.status === 404) return false;
    throw error;
  }
}

export async function getCustomer(key: string): Promise<Customer> {
  return toCustomer(await permit().api.users.get(key));
}

/**
 * Makes `representative` an editor on `account:<accountKey>`. The tenant is left out on purpose:
 * Permit then answers 404 for an account that does not exist instead of creating it.
 */
export async function assignCustomer(representative: string, accountKey: string): Promise<void> {
  await permit().api.roleAssignments.assign({
    user: representative,
    role: 'editor',
    resource_instance: `${ACCOUNT_PREFIX}${accountKey}`,
  });
}

export async function unassignCustomer(representative: string, accountKey: string): Promise<void> {
  await permit().api.roleAssignments.unassign({
    user: representative,
    role: 'editor',
    resource_instance: `${ACCOUNT_PREFIX}${accountKey}`,
    tenant: TENANT,
  });
}

/** Sets the customer's `plan` attribute and keeps their other attributes, such as `blocked`. */
export async function setPlan(customerKey: string, plan: Plan): Promise<void> {
  const user = await permit().api.users.get(customerKey);
  await permit().api.users.update(customerKey, { attributes: { ...attributesOf(user), plan } });
}
