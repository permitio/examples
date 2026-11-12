import type { DatabaseSync } from 'node:sqlite';
import { accountKeyFor, CURRENCY } from '@/lib/accounts';
import type { Auth } from '@/lib/auth';
import { upsertCustomer } from '@/lib/customers';
import type { Persona, SeedTransaction } from '@/lib/personas';
import type { ApiRequest, EnvironmentScope } from '@/setup/permit-rest';

const CONFLICT = [409] as const;

function nameParts(name: string): { first_name: string; last_name: string } {
  const [first = name, ...rest] = name.split(' ');
  return { first_name: first, last_name: rest.join(' ') };
}

/**
 * The demo data in Permit, in the order it must be written: accounts (tenants), users with their
 * registered country, account roles, then the seed transactions with their Sender and Receiver
 * relationships. Each call either is an upsert or treats "already exists" as done, so setup can run
 * again.
 */
export function seedRequests(
  { project, environment }: EnvironmentScope,
  personas: readonly Persona[],
  transactions: readonly SeedTransaction[],
): ApiRequest[] {
  const facts = `/v2/facts/${project}/${environment}`;
  const requests: ApiRequest[] = [];
  for (const { email } of personas) {
    requests.push({
      method: 'POST',
      path: `${facts}/tenants`,
      body: { key: accountKeyFor(email), name: email },
      accept: CONFLICT,
    });
  }
  for (const { email, name, country } of personas) {
    requests.push({
      method: 'PUT',
      path: `${facts}/users/${encodeURIComponent(email)}`,
      body: { key: email, email, ...nameParts(name), attributes: { country } },
    });
  }
  for (const { email, memberships } of personas) {
    const roles = [
      { role: 'AccountOwner', tenant: accountKeyFor(email) },
      ...memberships.map(({ accountOf, role }) => ({ role, tenant: accountKeyFor(accountOf) })),
    ];
    for (const { role, tenant } of roles) {
      requests.push({
        method: 'POST',
        path: `${facts}/role_assignments`,
        body: { user: email, role, tenant },
        accept: CONFLICT,
      });
    }
  }
  for (const { id, from, to, amount, description, date } of transactions) {
    const tenant = accountKeyFor(from);
    requests.push({
      method: 'POST',
      path: `${facts}/resource_instances`,
      body: {
        key: id,
        resource: 'Transaction',
        tenant,
        attributes: { id, date, description, amount, currency: CURRENCY, to: accountKeyFor(to) },
      },
      accept: CONFLICT,
    });
    for (const [role, user] of [
      ['Sender', from],
      ['Receiver', to],
    ] as const) {
      requests.push({
        method: 'POST',
        path: `${facts}/role_assignments`,
        body: { user, role, tenant, resource_instance: `Transaction:${id}` },
        accept: CONFLICT,
      });
    }
  }
  return requests;
}

/**
 * The demo users in Better Auth (email and password), and what the bank knows about them in the
 * `customer` table. Users who already exist keep their password.
 */
export async function seedLocalUsers(
  auth: Auth,
  db: DatabaseSync,
  personas: readonly Persona[],
  password: string,
): Promise<void> {
  const context = await auth.$context;
  for (const { email, name, country, location } of personas) {
    if ((await context.internalAdapter.findUserByEmail(email)) === null) {
      await auth.api.signUpEmail({ body: { email, name, password } });
    }
    upsertCustomer(db, { email, country, location });
  }
}
