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

/** Why a wire transfer was refused, in the `code` of a 403 answer. */
export type TransferRefusal =
  | { code: 'approval_required'; transfer: string }
  | { code: 'strong_auth_required' }
  | { code: 'invalid_code'; error: string }
  | { code: 'denied' };

/** What the browser needs to show Permit Elements; null when Permit could not be reached. */
export interface ElementsConfig {
  envId: string;
  embedUrl: string;
  apiUrl: string;
}
