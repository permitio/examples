// The mock's own copy of the request types. Keep them identical in shape to DemoRequest in apps/portal/src/server/model.ts.
export type RequestType = 'collaborator_invite' | 'renewal' | 'first_admin' | 'member_invite' | 'admin_transfer' | 'ean_association' | 'integration_access';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'canceled' | 'revoked' | 'expired';
export interface HistoryEntry { at: string; status: RequestStatus; by: string; comment?: string }
export interface DemoRequest {
  id: string; type: RequestType; tenant: string; target: string; role?: string;
  requested_for: string; initiated_by: string; reason?: string; duration_ms?: number; requested_days?: number; org_name?: string;
  status: RequestStatus; reviewer?: string; reviewer_comment?: string; created_at: string; updated_at: string; history: HistoryEntry[];
}
const ALLOWED: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ['approved', 'denied', 'canceled'], approved: ['revoked', 'expired'],
  denied: [], canceled: [], revoked: [], expired: [],
};
export class TransitionError extends Error {}
/** Returns the request moved to `to`, or throws TransitionError when the state machine does not allow the move. Never mutates `r`. */
export function transition(r: DemoRequest, to: RequestStatus, by: string, at: string, comment?: string, durationMs?: number): DemoRequest {
  if (!ALLOWED[r.status].includes(to)) throw new TransitionError(`Cannot move a ${r.status} request to ${to}`);
  const decided = to === 'approved' || to === 'denied';
  return {
    ...r, status: to, updated_at: at,
    // The approver sets how long an approved grant lasts; the request records it.
    ...(to === 'approved' && durationMs !== undefined ? { duration_ms: durationMs } : {}),
    ...(decided ? { reviewer: by, ...(comment !== undefined ? { reviewer_comment: comment } : {}) } : {}),
    history: [...r.history, { at, status: to, by, ...(comment !== undefined ? { comment } : {}) }],
  };
}
