// Where Aragorn stands on the shared shipment, as Aragorn's gate sign draws it. Read only from
// what the shipment detail already returns: Aragorn's grant entry, if any, and the newest invitation.

import type { Collaborator, DemoRequest } from '@/types';

export type AccessState = 'open' | 'pending' | 'ended' | 'none';

/**
 * Open while the grant is active and its expiry is still ahead of `demoNow` (the test GrantChip applies), pending
 * while the newest invitation waits for an approver, ended once a grant or an invitation exists without access, and
 * none when nothing was ever shared.
 */
export function accessState(grant: Collaborator | undefined, invite: DemoRequest | undefined, demoNow: number): AccessState {
  if (grant?.active && grant.expires !== null && grant.expires >= demoNow) return 'open';
  if (invite?.status === 'pending') return 'pending';
  return grant !== undefined || invite !== undefined ? 'ended' : 'none';
}
