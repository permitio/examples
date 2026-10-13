// What S5's Integrations pages decide from the portal's answer (GET /api/s5/integrations): which
// EANs "Make view-only" and "Revoke" act on, whether Pippin may ask for production again, and who
// approved. Pure functions, so no browser is needed.
import { describe, expect, it } from 'vitest';
import {
  approverOf,
  canAskForProduction,
  hasProductionAccess,
  type Integration,
  revokeTargets,
  type ScopeEntry,
  viewOnlyTargets,
} from '@/pages/s5/scope';
import type { DemoRequest, RequestStatus } from '@/types';

const client = (ean: string): ScopeEntry => ({
  role: 'integration_client',
  resource: `ean:${ean}`,
});
const reader = (ean: string): ScopeEntry => ({
  role: 'integration_reader',
  resource: `ean:${ean}`,
});

/** A production request for the connector, as the portal lists it. */
const request = (status: RequestStatus, reviewer?: string): DemoRequest =>
  ({
    id: `req-${status}`,
    type: 'integration_access',
    tenant: 'shire-freight',
    target: 'ean:EAN-1001',
    role: 'integration_client',
    requested_for: 'shire-erp',
    initiated_by: 'pippin',
    status,
    ...(reviewer === undefined ? {} : { reviewer }),
    created_at: 't0',
    updated_at: 't0',
    history: [],
  }) as unknown as DemoRequest;

const connector = (scope: ScopeEntry[], requests: DemoRequest[] = []): Integration => ({
  key: 'shire-erp',
  name: 'Shire ERP connector',
  owner: 'pippin',
  customer: 'shire-freight',
  customer_name: 'Shire Freight',
  scope,
  requests,
  recent: [],
});

describe('"Make view-only"', () => {
  it('acts on every production EAN where the connector can still create, and leaves the sandbox alone', () => {
    expect(
      viewOnlyTargets([client('EAN-SANDBOX'), client('EAN-1001'), client('EAN-1002')]),
    ).toEqual(['EAN-1001', 'EAN-1002']);
  });

  it('has nothing to do for a connector that is already view-only, has only the sandbox or has no access', () => {
    expect(viewOnlyTargets([client('EAN-SANDBOX'), reader('EAN-1001')])).toEqual([]);
    expect(viewOnlyTargets([client('EAN-SANDBOX')])).toEqual([]);
    expect(viewOnlyTargets([])).toEqual([]);
  });

  it('names an EAN once, and ignores a role on something that is not an EAN', () => {
    expect(
      viewOnlyTargets([
        client('EAN-1001'),
        client('EAN-1001'),
        { role: 'integration_client', resource: 'account:CA-1001-A' },
      ]),
    ).toEqual(['EAN-1001']);
  });
});

describe('"Revoke"', () => {
  it('acts on every EAN the connector holds any role on, production first and the sandbox last, each once', () => {
    expect(
      revokeTargets([
        client('EAN-SANDBOX'),
        client('EAN-1001'),
        reader('EAN-1001'),
        reader('EAN-1002'),
      ]),
    ).toEqual(['EAN-1001', 'EAN-1002', 'EAN-SANDBOX']);
  });

  it('has nothing to do once the connector holds no role', () => {
    expect(revokeTargets([])).toEqual([]);
  });
});

describe('production access', () => {
  it('is held only through integration_client on an EAN that is not the sandbox', () => {
    expect(hasProductionAccess([client('EAN-1001')])).toBe(true);
    expect(hasProductionAccess([reader('EAN-1001')])).toBe(false);
    expect(hasProductionAccess([client('EAN-SANDBOX')])).toBe(false);
  });

  it('can be asked for until a request waits or the connector holds it', () => {
    expect(canAskForProduction(connector([client('EAN-SANDBOX')]))).toBe(true);
    expect(canAskForProduction(connector([client('EAN-SANDBOX')], [request('pending')]))).toBe(
      false,
    );
    expect(
      canAskForProduction(
        connector([client('EAN-SANDBOX'), client('EAN-1001')], [request('approved', 'sam')]),
      ),
    ).toBe(false);
  });

  it('can be asked for again after a denial or a revocation', () => {
    expect(
      canAskForProduction(connector([client('EAN-SANDBOX')], [request('denied', 'sam')])),
    ).toBe(true);
    expect(canAskForProduction(connector([], [request('revoked', 'sam')]))).toBe(true);
  });
});

describe('who approved', () => {
  it('is the reviewer of the newest request that was approved, even once it is revoked', () => {
    expect(approverOf([request('approved', 'sam')])).toBe('sam');
    expect(approverOf([request('pending'), request('revoked', 'sam')])).toBe('sam');
  });

  it('is nobody while the request waits, and nobody when it was denied', () => {
    expect(approverOf([request('pending')])).toBeUndefined();
    expect(approverOf([request('denied', 'sam')])).toBeUndefined();
    expect(approverOf([])).toBeUndefined();
  });
});
