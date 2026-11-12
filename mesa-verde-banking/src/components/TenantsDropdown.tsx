'use client';

import { Select, Skeleton } from 'antd';
import { useAccount } from '@/components/AccountContext';

const ROLE_LABELS = {
  AccountOwner: 'owner',
  AccountBeneficiary: 'beneficiary',
  AccountMember: 'member',
} as const;

/** Picks the account to work in, among those the user holds a role in. */
export function TenantsDropdown() {
  const { accounts, currentTenant, selectAccount } = useAccount();
  if (accounts === null) return <Skeleton.Input active block />;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-lg">Account</span>
      <Select
        value={currentTenant}
        onChange={selectAccount}
        disabled={accounts.length < 2}
        notFoundContent="No accounts"
        options={accounts.map(({ key, name, role }) => ({
          value: key,
          label: `${name} (${ROLE_LABELS[role]})`,
        }))}
      />
    </label>
  );
}
