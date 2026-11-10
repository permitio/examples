'use client';

import { Alert } from 'antd';
import { AbilityProvider } from '@/components/AbilityContext';
import { AccountProvider, useAccount, type AccountUser } from '@/components/AccountContext';
import { AccountToolbar } from '@/components/AccountToolbar';
import { Balance } from '@/components/Balance';
import { TenantsDropdown } from '@/components/TenantsDropdown';
import { Transactions } from '@/components/Transactions';
import { TransactionsProvider } from '@/components/TransactionsContext';
import type { ElementsConfig } from '@/lib/api-types';

function AccountDashboard() {
  const { accountsError } = useAccount();
  if (accountsError !== null) {
    return <Alert type="error" title="Your accounts did not load" description={accountsError} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <TenantsDropdown />
      <AccountToolbar />
      <Balance />
      <Transactions />
    </div>
  );
}

export function AccountApp({
  user,
  elements,
}: {
  user: AccountUser;
  elements: ElementsConfig | null;
}) {
  return (
    <AccountProvider user={user} elements={elements}>
      <AbilityProvider>
        <TransactionsProvider>
          <AccountDashboard />
        </TransactionsProvider>
      </AbilityProvider>
    </AccountProvider>
  );
}
