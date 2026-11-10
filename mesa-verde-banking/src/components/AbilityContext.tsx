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

/** The user's abilities in the current account, while they load, or why they did not load. */
export type AbilityState =
  | { status: 'loading' }
  | { status: 'loaded'; abilities: Abilities }
  | { status: 'failed' };

const AbilityContext = createContext<AbilityState>({ status: 'loading' });

export function useAbilityState(): AbilityState {
  return useContext(AbilityContext);
}

/** The abilities once they have loaded, or null. */
export function useAbilities(): Abilities | null {
  const state = useContext(AbilityContext);
  return state.status === 'loaded' ? state.abilities : null;
}

/**
 * Loads the abilities with permit-fe-sdk: one bulk request to the app's frontend-permissions route,
 * which asks the PDP. The same policy that guards the API routes decides what the UI shows.
 */
export function AbilityProvider({ children }: { children: ReactNode }) {
  const { user, currentTenant } = useAccount();
  const [result, setResult] = useState<{ tenant: string; state: AbilityState } | null>(null);

  useEffect(() => {
    if (currentTenant === null) return undefined;
    let cancelled = false;
    const settle = (state: AbilityState) => {
      if (!cancelled) setResult({ tenant: currentTenant, state });
    };
    const permit = Permit({
      loggedInUser: user.email,
      backendUrl: `/account/api/frontend-permissions/${encodeURIComponent(currentTenant)}`,
    });
    // permit-fe-sdk keeps one state per page, so a new account starts from an empty one.
    permit.reset();
    const statements = FEATURES.map((feature) => PERMISSIONS[feature]);
    permit.loadLocalStateBulk(statements).then(
      () => {
        const abilities = Object.fromEntries(
          FEATURES.map((feature) => {
            const { action, resource, resourceAttributes } = PERMISSIONS[feature];
            // At runtime the third argument is the resource attributes; the SDK's typings call
            // it userAttributes.
            return [feature, permit.check(action, resource, resourceAttributes)];
          }),
        ) as Abilities;
        settle({ status: 'loaded', abilities });
      },
      () => settle({ status: 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [user.email, currentTenant]);

  const state: AbilityState =
    result !== null && result.tenant === currentTenant ? result.state : { status: 'loading' };
  return <AbilityContext value={state}>{children}</AbilityContext>;
}
