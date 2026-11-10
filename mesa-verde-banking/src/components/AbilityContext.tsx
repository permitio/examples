'use client';

import { Permit, type ActionResourceSchema } from 'permit-fe-sdk';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAccount } from '@/components/AccountContext';

type Feature =
  | 'READ_ACCOUNT'
  | 'LIST_TRANSACTIONS'
  | 'CREATE_WIRE_TRANSFER'
  | 'ADD_MEMBERS'
  | 'APPROVE_WIRE_TRANSFER';

/** The UI features that depend on the user's permissions in the current account. */
const PERMISSIONS: Record<Feature, Required<ActionResourceSchema> & { resource: string }> = {
  READ_ACCOUNT: { action: 'read', resource: 'Account', userAttributes: {}, resourceAttributes: {} },
  LIST_TRANSACTIONS: {
    action: 'list',
    resource: 'Transaction',
    userAttributes: {},
    resourceAttributes: {},
  },
  // A small transfer: beneficiaries may send those, so they see the button too.
  CREATE_WIRE_TRANSFER: {
    action: 'create',
    resource: 'Wire_Transfer',
    userAttributes: {},
    resourceAttributes: { amount: 100 },
  },
  ADD_MEMBERS: {
    action: 'add-members',
    resource: 'Account',
    userAttributes: {},
    resourceAttributes: {},
  },
  APPROVE_WIRE_TRANSFER: {
    action: 'approve',
    resource: 'Wire_Transfer',
    userAttributes: {},
    resourceAttributes: {},
  },
};

export type Abilities = Record<Feature, boolean>;

const FEATURES = Object.keys(PERMISSIONS) as Feature[];

/** Abilities, or null while they load or when they could not be loaded. */
const AbilityContext = createContext<Abilities | null>(null);

export function useAbilities(): Abilities | null {
  return useContext(AbilityContext);
}

/**
 * Loads the abilities with permit-fe-sdk: one bulk request to the app's frontend-permissions route,
 * which asks the PDP. The same policy that guards the API routes decides what the UI shows.
 */
export function AbilityProvider({ children }: { children: ReactNode }) {
  const { user, currentTenant } = useAccount();
  const [abilities, setAbilities] = useState<{ tenant: string; value: Abilities } | null>(null);

  useEffect(() => {
    if (currentTenant === null) return undefined;
    let cancelled = false;
    const permit = Permit({
      loggedInUser: user.email,
      backendUrl: `/account/api/frontend-permissions/${encodeURIComponent(currentTenant)}`,
    });
    // permit-fe-sdk keeps one state per page, so a new account starts from an empty one.
    permit.reset();
    const statements = FEATURES.map((feature) => PERMISSIONS[feature]);
    permit.loadLocalStateBulk(statements).then(
      () => {
        if (cancelled) return;
        const value = Object.fromEntries(
          FEATURES.map((feature) => {
            const { action, resource, resourceAttributes } = PERMISSIONS[feature];
            // At runtime the third argument is the resource attributes; the SDK's typings call
            // it userAttributes.
            return [feature, permit.check(action, resource, resourceAttributes)];
          }),
        ) as Abilities;
        setAbilities({ tenant: currentTenant, value });
      },
      (error: unknown) => {
        console.warn('Could not load the UI permissions', error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user.email, currentTenant]);

  const value = abilities !== null && abilities.tenant === currentTenant ? abilities.value : null;
  return <AbilityContext value={value}>{children}</AbilityContext>;
}
