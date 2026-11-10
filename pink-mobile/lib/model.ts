/** Types and constants shared by the pages, the API routes and the setup script. */

/** The only tenant this example uses. */
export const TENANT = 'default';

/** The manager persona: the Manager tab, and the lists the other tabs start from, act as Albus. */
export const MANAGER_KEY = 'albus@pink.mobile';

export const PLANS = ['VIP', 'Standard'] as const;
export type Plan = (typeof PLANS)[number];

export function isPlan(value: unknown): value is Plan {
  return PLANS.some((plan) => plan === value);
}

/** The plan a change moves a customer to: VIP customers go down to Standard, everyone else up. */
export function otherPlan(plan: Plan | null): Plan {
  return plan === 'VIP' ? 'Standard' : 'VIP';
}

/** A Permit user, as the API routes return it. Every user's key is their email address. */
export interface Person {
  key: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface Customer extends Person {
  plan: Plan | null;
  blocked: boolean;
}

export interface Representative extends Person {
  /** The owners of the accounts this representative is an editor on. */
  customers: Person[];
}

export interface AccountView {
  plan: Plan | null;
}

export interface ApiError {
  error: string;
}

const EMAIL = /^([^@\s:/]+)@[^@\s:/]+$/;

/**
 * A customer's account and plan instances share one key, the local part of their email:
 * `harry@potter.io` owns `account:harry`, which is the parent of `plan:harry`.
 *
 * @returns the key, or `undefined` when `email` is not an email address
 */
export function accountKeyOf(email: string): string | undefined {
  return EMAIL.exec(email)?.[1];
}

export function fullName(person: Person): string {
  return `${person.firstName} ${person.lastName}`;
}
