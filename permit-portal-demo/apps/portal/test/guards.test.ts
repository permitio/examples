import { describe, expect, it, vi } from 'vitest';
import { assertDifferentApprover, effectiveAdmins, SelfApprovalError } from '#src/server/guards';

describe('assertDifferentApprover', () => {
  const req = { initiated_by: 'frodo', requested_for: 'aragorn' };

  it.each(['frodo', 'aragorn'])(
    'refuses %s, who made the request or is its subject',
    (approver) => {
      expect(() => assertDifferentApprover(req, approver)).toThrow(SelfApprovalError);
    },
  );

  it('lets anyone else through', () => {
    expect(() => assertDifferentApprover(req, 'sam')).not.toThrow();
  });
});

describe('effectiveAdmins', () => {
  it('keeps only the holders whose check allows, asking once per holder', async () => {
    const isEffective = vi.fn(async (user: string) => user === 'eomer');
    await expect(effectiveAdmins(['eowyn', 'eomer'], isEffective)).resolves.toEqual(['eomer']);
    expect(isEffective.mock.calls).toEqual([['eowyn'], ['eomer']]);
  });

  it('finds no effective admin among no holders', async () => {
    await expect(effectiveAdmins([], async () => true)).resolves.toEqual([]);
  });
});
