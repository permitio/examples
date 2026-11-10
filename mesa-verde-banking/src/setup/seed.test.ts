import { beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '@/lib/auth';
import { findCustomer } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import { PERSONAS, SEED_TRANSACTIONS, type Persona } from '@/lib/personas';
import { seedLocalUsers, seedRequests } from '@/setup/seed';
import { prepareDatabase } from '@/test/auth';

const SCOPE = { project: 'p', environment: 'e' };
const FACTS = '/v2/facts/p/e';

const ALICE: Persona = {
  email: 'alice@mesaverde.example',
  name: 'Alice Owner',
  country: 'US',
  location: 'US',
  summary: '',
  memberships: [],
};
const BOB: Persona = {
  email: 'bob@mesaverde.example',
  name: 'Bob',
  country: 'GB',
  location: 'GB',
  summary: '',
  memberships: [{ accountOf: ALICE.email, role: 'AccountBeneficiary' }],
};

describe('seedRequests', () => {
  const transaction = {
    id: 'seed-1',
    from: ALICE.email,
    to: BOB.email,
    amount: 120,
    description: 'Dinner',
    date: '2026-10-02T18:30:00.000Z',
  };
  const requests = seedRequests(SCOPE, [ALICE, BOB], [transaction]);

  it('creates tenants first, then users, then roles, then transactions', () => {
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${FACTS}/tenants`,
      `POST ${FACTS}/tenants`,
      `PUT ${FACTS}/users/alice%40mesaverde.example`,
      `PUT ${FACTS}/users/bob%40mesaverde.example`,
      `POST ${FACTS}/role_assignments`,
      `POST ${FACTS}/role_assignments`,
      `POST ${FACTS}/role_assignments`,
      `POST ${FACTS}/resource_instances`,
      `POST ${FACTS}/role_assignments`,
      `POST ${FACTS}/role_assignments`,
    ]);
  });

  it("opens each persona's own account and treats an existing one as done", () => {
    expect(requests[0]).toEqual({
      method: 'POST',
      path: `${FACTS}/tenants`,
      body: { key: 'alice-mesaverde-example', name: ALICE.email },
      accept: [409],
    });
  });

  it('upserts users with their name and registered country', () => {
    expect(requests[2]?.body).toEqual({
      key: ALICE.email,
      email: ALICE.email,
      first_name: 'Alice',
      last_name: 'Owner',
      attributes: { country: 'US' },
    });
  });

  it('makes everyone the owner of their account, plus their roles in other accounts', () => {
    expect(requests.slice(4, 7).map(({ body }) => body)).toEqual([
      { user: ALICE.email, role: 'AccountOwner', tenant: 'alice-mesaverde-example' },
      { user: BOB.email, role: 'AccountOwner', tenant: 'bob-mesaverde-example' },
      { user: BOB.email, role: 'AccountBeneficiary', tenant: 'alice-mesaverde-example' },
    ]);
  });

  it('writes a transaction in the sending account, with its Sender and Receiver', () => {
    expect(requests[7]).toEqual({
      method: 'POST',
      path: `${FACTS}/resource_instances`,
      body: {
        key: 'seed-1',
        resource: 'Transaction',
        tenant: 'alice-mesaverde-example',
        attributes: {
          id: 'seed-1',
          date: transaction.date,
          description: 'Dinner',
          amount: 120,
          currency: '£',
          to: 'bob-mesaverde-example',
        },
      },
      accept: [409],
    });
    expect(requests.slice(8).map(({ body }) => body)).toEqual([
      {
        user: ALICE.email,
        role: 'Sender',
        tenant: 'alice-mesaverde-example',
        resource_instance: 'Transaction:seed-1',
      },
      {
        user: BOB.email,
        role: 'Receiver',
        tenant: 'alice-mesaverde-example',
        resource_instance: 'Transaction:seed-1',
      },
    ]);
  });

  it('only refers to personas that exist', () => {
    const emails = new Set(PERSONAS.map(({ email }) => email));
    for (const { memberships } of PERSONAS) {
      for (const { accountOf } of memberships) expect(emails).toContain(accountOf);
    }
    for (const { from, to } of SEED_TRANSACTIONS) {
      expect(emails).toContain(from);
      expect(emails).toContain(to);
    }
  });
});

describe('seedLocalUsers', () => {
  beforeAll(async () => {
    await prepareDatabase();
  });

  it('creates the demo users and their customer records, and can run again', async () => {
    await seedLocalUsers(getAuth(), getDatabase(), [ALICE, BOB], 'demo-password-1');
    await seedLocalUsers(getAuth(), getDatabase(), [ALICE, BOB], 'another-password');

    const signIn = await getAuth().api.signInEmail({
      body: { email: BOB.email, password: 'demo-password-1' },
    });
    expect(signIn.user.email).toBe(BOB.email);
    expect(findCustomer(getDatabase(), BOB.email)).toEqual({
      email: BOB.email,
      country: 'GB',
      location: 'GB',
    });
  });
});
