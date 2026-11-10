'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAbilityState } from '@/components/AbilityContext';
import { useAccount } from '@/components/AccountContext';
import type { TransactionRow } from '@/lib/api-types';

type TransactionsState =
  | { status: 'loading' }
  | { status: 'loaded'; transactions: TransactionRow[] }
  | { status: 'forbidden' }
  | { status: 'failed' };

interface TransactionsContextValue {
  state: TransactionsState;
  reload: () => void;
}

const TransactionsContext = createContext<TransactionsContextValue | undefined>(undefined);

export function useTransactions(): TransactionsContextValue {
  const context = useContext(TransactionsContext);
  if (context === undefined) {
    throw new Error('useTransactions must be used within a TransactionsProvider');
  }
  return context;
}

async function loadTransactions(tenant: string): Promise<TransactionsState> {
  const response = await fetch(`/account/api/transactions?tenant=${encodeURIComponent(tenant)}`);
  if (response.status === 403) return { status: 'forbidden' };
  if (!response.ok) return { status: 'failed' };
  return { status: 'loaded', transactions: (await response.json()) as TransactionRow[] };
}

/** Whether the user may list the account's transactions, once the abilities have loaded. */
function useMayList(): boolean | 'loading' | 'failed' {
  const ability = useAbilityState();
  return ability.status === 'loaded' ? ability.abilities.LIST_TRANSACTIONS : ability.status;
}

/**
 * The current account's transactions. They are fetched only when Permit lets the user list them;
 * otherwise the list says so without asking the API for a 403.
 */
export function TransactionsProvider({ children }: { children: ReactNode }) {
  const { currentTenant } = useAccount();
  const mayList = useMayList();
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; state: TransactionsState } | null>(null);
  const key = `${currentTenant ?? ''}#${version}`;

  useEffect(() => {
    if (currentTenant === null || mayList !== true) return undefined;
    let cancelled = false;
    const settle = (state: TransactionsState) => {
      if (!cancelled) setResult({ key, state });
    };
    loadTransactions(currentTenant).then(settle, () => settle({ status: 'failed' }));
    return () => {
      cancelled = true;
    };
  }, [currentTenant, key, mayList]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  let state: TransactionsState;
  if (mayList === 'loading') state = { status: 'loading' };
  else if (mayList === 'failed') state = { status: 'failed' };
  else if (!mayList) state = { status: 'forbidden' };
  else state = result?.key === key ? result.state : { status: 'loading' };

  return <TransactionsContext value={{ state, reload }}>{children}</TransactionsContext>;
}
