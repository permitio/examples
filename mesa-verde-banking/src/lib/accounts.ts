/** The roles a user can hold in an account (a Permit tenant), from main.tf. */
export const ACCOUNT_ROLES = ['AccountOwner', 'AccountBeneficiary', 'AccountMember'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Permit's tenant, user and resource instance keys: letters, digits, `-` and `_`. */
export const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

const NOT_KEY_CHARACTERS = /[^a-z0-9]+/g;

/**
 * The key of the account a user opens when they first sign in: their email address in lower case,
 * with each run of other characters replaced by `-`. `alice@mesaverde.example` owns the account
 * `alice-mesaverde-example`. The whole address goes into the key, so two users whose addresses
 * share the part before the `@` do not share an account.
 */
export function accountKeyFor(email: string): string {
  const key = email.toLowerCase().replace(NOT_KEY_CHARACTERS, '-').replace(/^-|-$/g, '');
  if (key === '') {
    throw new Error(`Cannot derive an account key from the email address ${email}`);
  }
  return key;
}

/** The currency of every account. */
export const CURRENCY = '£';

/**
 * A made-up balance that stays the same for an account. The demo is about who may move money, not
 * about bookkeeping, so transfers do not change it.
 */
export function demoBalance(account: string): number {
  let hash = 7;
  for (const character of account) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100_000_000;
  }
  return hash / 100;
}
