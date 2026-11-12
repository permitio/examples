'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Account, ElementsConfig } from '@/lib/api-types';

export interface AccountUser {
  email: string;
  name: string;
}

interface AccountContextValue {
  user: AccountUser;
  /** The user's accounts; null while they load. */
  accounts: Account[] | null;
  accountsError: string | null;
  currentTenant: string | null;
  selectAccount: (key: string) => void;
  elements: ElementsConfig | null;
}

const AccountContext = createContext<AccountContextValue | undefined>(undefined);

export function useAccount(): AccountContextValue {
  const context = useContext(AccountContext);
  if (context === undefined) throw new Error('useAccount must be used within an AccountProvider');
  return context;
}

export function AccountProvider({
  user,
  elements,
  children,
}: {
  user: AccountUser;
  elements: ElementsConfig | null;
  children: ReactNode;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/account/api/tenants')
      .then(async (response) => {
        if (!response.ok) throw new Error(`The accounts did not load (HTTP ${response.status})`);
        return (await response.json()) as Account[];
      })
      .then(
        (loaded) => {
          if (!cancelled) setAccounts(loaded);
        },
        (error: unknown) => {
          if (!cancelled) setAccountsError(error instanceof Error ? error.message : String(error));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [user.email]);

  const currentTenant = selected ?? accounts?.[0]?.key ?? null;

  return (
    <AccountContext
      value={{
        user,
        accounts,
        accountsError,
        currentTenant,
        selectAccount: setSelected,
        elements,
      }}
    >
      {children}
    </AccountContext>
  );
}
