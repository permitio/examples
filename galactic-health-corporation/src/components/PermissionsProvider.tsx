'use client';

import { createMongoAbility } from '@casl/ability';
import { AbilityProvider } from '@casl/react';
import { Permit } from 'permit-fe-sdk';
import { type ReactNode, useEffect, useState } from 'react';
import { useUserContext } from '@/contexts/UserContext';

/** The pilot-group features the dashboard shows or hides. */
const FEATURES = [
  { action: 'view', resource: 'benefits_pg' },
  { action: 'view', resource: 'alt_medicine_pg' },
];

/**
 * Asks Permit, once per signed-in member, which pilot-group features they may see, and provides the
 * answers as a CASL ability for `<Can>` (from `@casl/react`).
 */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const userId = useUserContext().loggedInUser?.id;
  const [ability] = useState(() => createMongoAbility());

  useEffect(() => {
    if (userId === undefined) return undefined;
    let active = true;
    const permit = Permit({ loggedInUser: userId, backendUrl: '/api/permissions' });
    // The SDK keeps its answers in module state; start clean for this member.
    permit.reset();
    // Permit check: POST /api/permissions runs one bulk check for every feature.
    permit.loadLocalStateBulk(FEATURES).then(
      () => {
        if (active) ability.update(permit.getCaslJson());
      },
      (error: unknown) => console.error('Could not load permissions from /api/permissions', error),
    );
    return () => {
      active = false;
    };
  }, [ability, userId]);

  return <AbilityProvider value={ability}>{children}</AbilityProvider>;
}
