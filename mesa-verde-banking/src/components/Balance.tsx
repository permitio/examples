'use client';

import { Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import { useAbilityState } from '@/components/AbilityContext';
import { useAccount } from '@/components/AccountContext';
import type { Balance as BalanceBody } from '@/lib/api-types';
import { formatMoney } from '@/lib/format';

type BalanceState = { status: 'loaded'; body: BalanceBody } | { status: 'forbidden' | 'failed' };

/** The balance, fetched only when Permit lets the user read the account. */
export function Balance() {
  const { currentTenant } = useAccount();
  const ability = useAbilityState();
  const mayRead = ability.status === 'loaded' ? ability.abilities.READ_ACCOUNT : ability.status;
  const [result, setResult] = useState<{ tenant: string; state: BalanceState } | null>(null);

  useEffect(() => {
    if (currentTenant === null || mayRead !== true) return undefined;
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
  }, [currentTenant, mayRead]);

  let state: BalanceState | undefined;
  if (mayRead === 'failed') state = { status: 'failed' };
  else if (mayRead === false) state = { status: 'forbidden' };
  else if (mayRead === true && result?.tenant === currentTenant) state = result.state;
  if (state === undefined) return <Skeleton.Input active block />;
  return (
    <div className="flex justify-between border-b border-slate-200 pb-2">
      <span className="text-lg font-semibold text-slate-600">Balance</span>
      <span className="text-xl">
        {state.status === 'loaded'
          ? formatMoney(state.body.currency, state.body.balance)
          : state.status === 'forbidden'
            ? 'Not allowed to see the balance'
            : 'The balance did not load'}
      </span>
    </div>
  );
}
