import { describe, expect, it } from 'vitest';
import { transition, TransitionError, type DemoRequest } from '#src/requests';

const base: DemoRequest = {
  id: 'r1',
  type: 'collaborator_invite',
  tenant: 'shire-freight',
  target: 'shipment:SHP-77001',
  role: 'collaborator',
  requested_for: 'aragorn',
  initiated_by: 'frodo',
  status: 'pending',
  created_at: 't0',
  updated_at: 't0',
  history: [{ at: 't0', status: 'pending', by: 'frodo' }],
};

describe('transition', () => {
  it('approves a pending request and records reviewer, comment and history', () => {
    const r = transition(base, 'approved', 'sam', 't1', 'ok');
    expect(r).toMatchObject({
      status: 'approved',
      reviewer: 'sam',
      reviewer_comment: 'ok',
      updated_at: 't1',
    });
    expect(r.history.at(-1)).toEqual({ at: 't1', status: 'approved', by: 'sam', comment: 'ok' });
  });
  it.each([
    ['approved', 'approved'],
    ['denied', 'approved'],
    ['revoked', 'approved'],
    ['pending', 'revoked'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => transition({ ...base, status: from }, to, 'sam', 't1')).toThrow(TransitionError);
  });
  it('allows approved -> revoked and approved -> expired', () => {
    expect(transition({ ...base, status: 'approved' }, 'revoked', 'frodo', 't2').status).toBe(
      'revoked',
    );
    expect(transition({ ...base, status: 'approved' }, 'expired', 'cleanup-job', 't2').status).toBe(
      'expired',
    );
  });
  it('does not mutate its input', () => {
    transition(base, 'denied', 'sam', 't1');
    expect(base.status).toBe('pending');
  });
});
