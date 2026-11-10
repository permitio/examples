'use client';

import { Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import { useAccount } from '@/components/AccountContext';
import type { Balance as BalanceBody } from '@/lib/api-types';

type BalanceState = { status: 'loaded'; body: BalanceBody } | { status: 'forbidden' | 'failed' };

export function Balance() {
  const { currentTenant } = useAccount();
  const [result, setResult] = useState<{ tenant: string; state: BalanceState } | null>(null);

  useEffect(() => {
    if (currentTenant === null) return undefined;
    let cancelled = false;
    const settle = (state: BalanceState) => {
      if (!cancelled) setResult({ tenant: currentTenant, state });
    };
    fetch(`/account/api/balance?tenant=${encodeURIComponent(currentTenant)}`)
      .then(async (response): Promise<BalanceState> => {
        if (response.status === 403) return { status: 'forbidden' };
        if (!response.ok) return { status: 'failed' };
        return { status: 'loaded', body: (await response.json()) as BalanceBody };
      })
      .then(settle, () => settle({ status: 'failed' }));
    return () => {
      cancelled = true;
    };
  }, [currentTenant]);

  if (result === null || result.tenant !== currentTenant) {
    return <Skeleton.Input active block />;
  }
  const { state } = result;
  return (
    <div className="flex justify-between border-b border-slate-200 pb-2">
      <span className="text-lg font-semibold text-slate-600">Balance</span>
      <span className="text-xl">
        {state.status === 'loaded'
          ? `${state.body.currency}${state.body.balance.toFixed(2)}`
          : state.status === 'forbidden'
            ? 'Not allowed to see the balance'
            : 'The balance did not load'}
      </span>
    </div>
  );
}
