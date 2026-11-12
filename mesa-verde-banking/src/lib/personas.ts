import type { AccountRole } from '@/lib/accounts';

/** The password of every demo user. Only for local demos: anyone can read it here. */
export const DEMO_PASSWORD = 'mesa-verde-demo';

export interface Persona {
  email: string;
  name: string;
  /** Registered address country, synced to Permit as the `country` user attribute. */
  country: string;
  /** Where the persona signs in from, sent with each transfer check as `location`. */
  location: string;
  /** What the persona shows, for the sign-in page and the README. */
  summary: string;
  /** Roles in other personas' accounts. Every persona also owns an account of their own. */
  memberships: ReadonlyArray<{ accountOf: string; role: Exclude<AccountRole, 'AccountOwner'> }>;
}

export const PERSONAS: readonly Persona[] = [
  {
    email: 'alice@mesaverde.example',
    name: 'Alice Owner',
    country: 'US',
    location: 'US',
    summary: 'Owns an account and signs in from home: any transfer goes through.',
    memberships: [],
  },
  {
    email: 'bob@mesaverde.example',
    name: 'Bob Beneficiary',
    country: 'GB',
    location: 'GB',
    summary:
      "Beneficiary of Alice's account: transfers up to £1,000 from it, larger ones need Alice's approval.",
    memberships: [{ accountOf: 'alice@mesaverde.example', role: 'AccountBeneficiary' }],
  },
  {
    email: 'carol@mesaverde.example',
    name: 'Carol Member',
    country: 'US',
    location: 'US',
    summary: "Member of Alice's account: sees the balance, asks for access to the transactions.",
    memberships: [{ accountOf: 'alice@mesaverde.example', role: 'AccountMember' }],
  },
  {
    email: 'dave@mesaverde.example',
    name: 'Dave Traveler',
    country: 'US',
    location: 'FR',
    summary:
      'Owns an account but signs in from abroad: transfers over £1,000 need a one-time code.',
    memberships: [],
  },
];

export interface SeedTransaction {
  id: string;
  from: string;
  to: string;
  amount: number;
  description: string;
  date: string;
}

/** Transfers that exist before anyone signs in, so the accounts have some history. */
export const SEED_TRANSACTIONS: readonly SeedTransaction[] = [
  {
    id: 'seed-alice-1',
    from: 'alice@mesaverde.example',
    to: 'bob@mesaverde.example',
    amount: 120,
    description: 'Dinner',
    date: '2026-10-02T18:30:00.000Z',
  },
  {
    id: 'seed-alice-2',
    from: 'alice@mesaverde.example',
    to: 'dave@mesaverde.example',
    amount: 1500,
    description: 'Car repair',
    date: '2026-10-09T10:15:00.000Z',
  },
  {
    id: 'seed-dave-1',
    from: 'dave@mesaverde.example',
    to: 'alice@mesaverde.example',
    amount: 80,
    description: 'Concert tickets',
    date: '2026-10-12T20:00:00.000Z',
  },
];
