import type { AccountRole } from '@/lib/accounts';

/** The shapes the app's API routes answer with, shared by the routes and the browser code. */

export interface Account {
  key: string;
  name: string;
  role: AccountRole;
}

export interface Recipient {
  key: string;
  name: string;
}

export interface Balance {
  balance: number;
  currency: string;
}

export interface TransactionRow {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency: string;
  direction: 'out' | 'in';
}

/**
 * What happened to a wire transfer the API accepted (HTTP 200): sent, or waiting for a next step,
 * the way payment APIs answer "requires action" for a step-up.
 */
export type TransferOutcome =
  | { status: 'sent'; transaction: Omit<TransactionRow, 'direction'> & { to: string } }
  | { status: 'approval_required'; transfer: string }
  | { status: 'strong_auth_required' };

/** Why a wire transfer was refused, in the `code` of a 403 answer. */
export type TransferRefusal = { code: 'invalid_code'; error: string } | { code: 'denied' };

/** What the browser needs to show Permit Elements; null when Permit could not be reached. */
export interface ElementsConfig {
  envId: string;
  embedUrl: string;
  apiUrl: string;
}
