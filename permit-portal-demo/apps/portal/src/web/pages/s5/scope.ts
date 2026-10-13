// What S5's Integrations pages decide from the portal's answer to GET /api/s5/integrations, as pure
// functions: which EANs "Make view-only" and "Revoke" act on, whether production access can be
// asked for, and who approved it.

import type { DemoRequest } from '@/types';

/** A role the connector holds on one resource, as Permit lists it: `resource` is `type:key`. */
export interface ScopeEntry {
  role: string;
  resource: string;
}

/**
 * One call a connector made, as the portal recorded its check: what it asked, about what, Permit's
 * answer and when (epoch ms).
 */
export interface RecentCall {
  action: string;
  /** `type:key`. */
  resource: string;
  allow: boolean;
  at: number;
}

/**
 * A connector as the portal lists it: who owns it, the organization it acts for, what Permit lets
 * it do now, the production requests made for it (newest first) and its latest calls (newest first,
 * at most ten, none from before it was registered).
 */
export interface Integration {
  key: string;
  name: string;
  owner: string;
  /** The organization it acts for: its tenant key. */
  customer: string;
  /** The organization's name, for the screen. */
  customer_name: string;
  scope: ScopeEntry[];
  requests: DemoRequest[];
  recent: RecentCall[];
}

/** GET /api/s5/integrations */
export interface IntegrationsResponse {
  integrations: Integration[];
}

/**
 * POST /api/s5/integrations: the connector, and, this once, the client secret Great Eagle's systems
 * issued.
 */
export interface RegisterResponse {
  integration: Integration;
  client_secret: string;
}

/** The EAN every connector is registered with: scope to test against, never production. */
export const SANDBOX_EAN = 'EAN-SANDBOX';
/** The EAN the production request form starts with. */
export const PRODUCTION_EAN = 'EAN-1001';
/**
 * The reason it starts with, as S4's invitation starts with its own: the presenter never types on
 * camera.
 */
export const PRODUCTION_REASON = 'Nightly order sync from Shire ERP into EAN-1001';

const EAN_PREFIX = 'ean:';

/** The EAN keys of `scope`'s entries that pass `keep`, each once, in the order Permit listed them. */
function eansOf(scope: readonly ScopeEntry[], keep: (entry: ScopeEntry) => boolean): string[] {
  const eans = scope
    .filter((entry) => entry.resource.startsWith(EAN_PREFIX) && keep(entry))
    .map((entry) => entry.resource.slice(EAN_PREFIX.length));
  return [...new Set(eans)];
}

/**
 * The EANs "Make view-only" changes: production EANs where the connector can still create. The
 * sandbox is test scope and stays as it is.
 */
export function viewOnlyTargets(scope: readonly ScopeEntry[]): string[] {
  return eansOf(scope, (entry) => entry.role === 'integration_client').filter(
    (ean) => ean !== SANDBOX_EAN,
  );
}

/**
 * The EANs "Revoke" ends: every EAN the connector holds any role on, the production ones first and
 * the sandbox last.
 */
export function revokeTargets(scope: readonly ScopeEntry[]): string[] {
  const eans = eansOf(scope, () => true);
  return [
    ...eans.filter((ean) => ean !== SANDBOX_EAN),
    ...eans.filter((ean) => ean === SANDBOX_EAN),
  ];
}

/** Whether the connector can create shipments on an EAN other than the sandbox. */
export function hasProductionAccess(scope: readonly ScopeEntry[]): boolean {
  return viewOnlyTargets(scope).length > 0;
}

/**
 * Production access can be asked for while no request waits for a decision and the connector does
 * not hold it.
 */
export function canAskForProduction(integration: Integration): boolean {
  return (
    !integration.requests.some((request) => request.status === 'pending') &&
    !hasProductionAccess(integration.scope)
  );
}

/**
 * Who approved the connector's production access: the reviewer of its newest request that was
 * approved, revoked since or not.
 */
export function approverOf(requests: readonly DemoRequest[]): string | undefined {
  return requests.find((request) => request.status === 'approved' || request.status === 'revoked')
    ?.reviewer;
}
