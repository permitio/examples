'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
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

export function TransactionsProvider({ children }: { children: ReactNode }) {
  const { currentTenant } = useAccount();
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; state: TransactionsState } | null>(null);
  const key = `${currentTenant ?? ''}#${version}`;

  useEffect(() => {
    if (currentTenant === null) return undefined;
    let cancelled = false;
    const settle = (state: TransactionsState) => {
      if (!cancelled) setResult({ key, state });
    };
    loadTransactions(currentTenant).then(settle, () => settle({ status: 'failed' }));
    return () => {
      cancelled = true;
    };
  }, [currentTenant, key]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const state: TransactionsState = result?.key === key ? result.state : { status: 'loading' };

  return <TransactionsContext value={{ state, reload }}>{children}</TransactionsContext>;
}
