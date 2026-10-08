import { describe, expect, it } from 'vitest';
import { accessState } from '../src/web/pages/s4/access';
import type { Collaborator, DemoRequest, RequestStatus } from '../src/web/types';

const NOW = 1_791_280_800_000;

const grant = (over: Partial<Collaborator> = {}): Collaborator => ({ user: 'aragorn', expires: NOW + 60_000, renewals_used: 0, active: true, ...over });

const invite = (status: RequestStatus): DemoRequest => ({
  id: 'req-1',
  type: 'collaborator_invite',
  tenant: 'shire-freight',
  target: 'shipment:SHP-77001',
  requested_for: 'aragorn',
  initiated_by: 'frodo',
  status,
  created_at: '2026-10-06T10:00:00.000Z',
  updated_at: '2026-10-06T10:00:00.000Z',
  history: [],
});

describe("Aragorn's gate on the shared shipment", () => {
  it('is open while the grant is active and its expiry is still ahead on the demo clock', () => {
    expect(accessState(grant(), invite('approved'), NOW)).toBe('open');
  });

  it('stays open up to the expiry instant, where the countdown reads 0:00', () => {
    expect(accessState(grant({ expires: NOW }), invite('approved'), NOW)).toBe('open');
  });

  it('ends the moment the demo clock passes the expiry, while the entry is still on record', () => {
    expect(accessState(grant({ expires: NOW - 1 }), invite('approved'), NOW)).toBe('ended');
  });

  it('is ended when the portal read the grant as inactive, whatever its expiry says', () => {
    expect(accessState(grant({ active: false }), invite('approved'), NOW)).toBe('ended');
  });

  it('is ended for a grant entry that carries no expiry', () => {
    expect(accessState(grant({ expires: null }), invite('approved'), NOW)).toBe('ended');
  });

  it('is ended for a lapsed grant even when no invitation for it is on record', () => {
    expect(accessState(grant({ expires: NOW - 1 }), undefined, NOW)).toBe('ended');
  });

  it('is pending while the newest invitation waits for an approver', () => {
    expect(accessState(undefined, invite('pending'), NOW)).toBe('pending');
  });

  it('shows a waiting invitation over a lapsed grant, and a live grant over a waiting invitation', () => {
    expect(accessState(grant({ expires: NOW - 1 }), invite('pending'), NOW)).toBe('pending');
    expect(accessState(grant(), invite('pending'), NOW)).toBe('open');
  });

  it.each(['approved', 'expired', 'revoked', 'denied', 'canceled'] as const)('is ended without a grant once the invitation is %s', (status) => {
    expect(accessState(undefined, invite(status), NOW)).toBe('ended');
  });

  it('is none when nothing was ever shared', () => {
    expect(accessState(undefined, undefined, NOW)).toBe('none');
  });
});
