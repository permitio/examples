import { type CollaboratorGrant, QUEUE_KEY, RESOURCE, ROLE, type SeedData, type SeedPersona, TENANT } from '../../src/server/model';
import type { Attributes, CheckSpec } from './pdp';

export const HOUR_MS = 3_600_000;
/** The S4 broker: the only persona whose access comes from grant entries, so Aragorn's starting state is "no grants". */
export const ARAGORN = 'aragorn';

export interface TenantSpec { key: string; name: string }
export interface InstanceSpec { resource: string; key: string; tenant: string; attributes: Attributes }
export interface TupleSpec { subject: string; relation: string; object: string; tenant: string }
/** `tenant`: create the user inside this tenant with no role, so Permit's directory lists them there. */
export interface UserSpec { key: string; first_name: string; last_name: string; attributes: Attributes; tenant?: string }
export interface AssignmentSpec { user: string; role: string; tenant: string; resource_instance?: string }
export interface PermitData { tenants: TenantSpec[]; instances: InstanceSpec[]; tuples: TupleSpec[]; users: UserSpec[]; assignments: AssignmentSpec[] }

/**
 * Personas who belong to a tenant without holding a role there. Aragorn, the outside broker, is listed under Shire
 * Freight in Permit's directory so the dashboard shows Aragorn beside Sam and Frodo, with no role.
 */
const DIRECTORY_TENANT: Record<string, string> = { aragorn: 'shire-freight' };

/** Every instance stores its own key as `id`, the attribute the rules read. */
export const instance = (resource: string, key: string, tenant: string, attributes: Attributes = {}): InstanceSpec =>
  ({ resource, key, tenant, attributes: { ...attributes, id: key } });
/** `parent` (`type:key`) is the parent of `child`: the tuple's subject is the parent, as each child's `parent` relation declares. */
const parentTuple = (parent: string, child: string, tenant: string): TupleSpec => ({ subject: parent, relation: 'parent', object: child, tenant });
const ref = (type: string, key: string) => `${type}:${key}`;

/** The tenant of each child account and location: the organization that owns the EAN above it. */
function tenantsBelowEans(seed: SeedData): { account: Map<string, string>; location: Map<string, string> } {
  const eanOrg = new Map(seed.eans.map((e) => [e.key, e.org]));
  const account = new Map(seed.accounts.map((a) => {
    const org = eanOrg.get(a.ean);
    if (org === undefined) throw new Error(`demo-data/seed.json: account ${a.key} is on unknown EAN ${a.ean}`);
    return [a.key, org];
  }));
  const location = new Map(seed.locations.map((l) => {
    const org = account.get(l.account);
    if (org === undefined) throw new Error(`demo-data/seed.json: location ${l.key} is on unknown account ${l.account}`);
    return [l.key, org];
  }));
  return { account, location };
}

export function splitName(name: string): { first_name: string; last_name: string } {
  const [first = name, ...rest] = name.split(' ');
  return { first_name: first, last_name: rest.join(' ') };
}

/** A persona's attributes at the start of the demo: the trust facts from seed.json, and no grants for Aragorn. */
export function personaAttributes(p: SeedPersona): Attributes {
  return { ...(p.facts ?? {}), ...(p.key === ARAGORN ? { time_based_grants: [] } : {}) };
}

/**
 * The demo's Permit data, built from demo-data/seed.json: EAN-SANDBOX
 * among the EANs, and the child accounts and locations under their EANs.
 */
export function demoData(seed: SeedData): PermitData {
  const seededOrgs = seed.organizations.filter((o) => o.in_permit === 'seed');
  const tenantOf = tenantsBelowEans(seed);
  const accountTenant = (key: string) => tenantOf.account.get(key) ?? '';
  const locationTenant = (key: string) => tenantOf.location.get(key) ?? '';
  return {
    tenants: [...seededOrgs.map((o) => ({ key: o.key, name: o.name })), { key: TENANT.operator, name: 'Great Eagle internal' }],
    instances: [
      ...seededOrgs.map((o) => instance(RESOURCE.organization, o.key, o.key, { ownership_verified: o.ownership_verified })),
      ...seed.eans.filter((e) => e.in_permit).map((e) => instance(RESOURCE.ean, e.key, e.org, { association_verified: true })),
      ...seed.accounts.map((a) => instance(RESOURCE.account, a.key, accountTenant(a.key))),
      ...seed.locations.map((l) => instance(RESOURCE.location, l.key, locationTenant(l.key))),
      ...seed.shipments.map((s) => instance(RESOURCE.shipment, s.key, s.tenant)),
      instance(RESOURCE.onboardingQueue, QUEUE_KEY, TENANT.operator),
    ],
    tuples: [
      ...seed.accounts.map((a) => parentTuple(ref(RESOURCE.ean, a.ean), ref(RESOURCE.account, a.key), accountTenant(a.key))),
      ...seed.locations.map((l) => parentTuple(ref(RESOURCE.account, l.account), ref(RESOURCE.location, l.key), locationTenant(l.key))),
      ...seed.shipments.map((s) => parentTuple(ref(RESOURCE.ean, s.ean), ref(RESOURCE.shipment, s.key), s.tenant)),
    ],
    users: seed.personas.map((p) => ({
      key: p.key, ...splitName(p.name), attributes: personaAttributes(p),
      ...(DIRECTORY_TENANT[p.key] === undefined ? {} : { tenant: DIRECTORY_TENANT[p.key] }),
    })),
    assignments: [
      { user: 'sam', role: ROLE.orgAdmin, tenant: TENANT.shire },
      { user: 'frodo', role: ROLE.orgMember, tenant: TENANT.shire },
      { user: 'frodo', role: ROLE.accountAdmin, tenant: TENANT.shire, resource_instance: ref(RESOURCE.ean, 'EAN-1001') },
      { user: 'gandalf', role: ROLE.onboardingReviewer, tenant: TENANT.operator },
      // S2's member and S5's developer: in the organization, with no role on any resource until the scenarios grant one.
      { user: 'merry', role: ROLE.orgMember, tenant: TENANT.shire },
      { user: 'pippin', role: ROLE.orgMember, tenant: TENANT.shire },
      { user: 'pippin', role: ROLE.developer, tenant: TENANT.shire },
    ],
  };
}

// --- The preflight tenant: fixtures for the expectation matrix ---

const PF = TENANT.preflight;
const PF_GRANT_SHIPMENT = 'PF-S1';
const fixtureUser = (key: string, attributes: Attributes): UserSpec => ({ key, first_name: 'Preflight', last_name: key, attributes });
const adminFixture = (key: string, facts: Attributes = {}) =>
  fixtureUser(key, { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok', ...facts });
const grant = (expires: number, renewals_used: number): CollaboratorGrant =>
  ({ resource: PF_GRANT_SHIPMENT, role: 'collaborator', expires, renewals_used });

/** The collaborator fixtures. Their grants are relative to `now`, so preflight rewrites them before every run. */
export function collaboratorFixtures(now: number): UserSpec[] {
  return [
    fixtureUser('pf-collab-active', { time_based_grants: [grant(now + HOUR_MS, 0)] }),
    fixtureUser('pf-collab-expired', { time_based_grants: [grant(now - HOUR_MS, 0)] }),
    fixtureUser('pf-collab-renewable', { time_based_grants: [grant(now + HOUR_MS, 1)] }),
    fixtureUser('pf-collab-maxed', { time_based_grants: [grant(now + HOUR_MS, 2)] }),
  ];
}

/** pf-admin-ok's facts, which `measure` flips and restores. */
export const PF_ADMIN_OK = adminFixture('pf-admin-ok');

/**
 * The preflight tenant's data. Two chains, PF-E1 > PF-A1 > PF-L1 and PF-E2 > PF-A2 > PF-L2: pf-ean-admin is admin of
 * PF-E1 only, so the second chain is where its grant rights must stop. pf-org-admin is a verified org admin that
 * `measure` never flips, unlike pf-admin-ok.
 */
export function preflightData(now: number): PermitData {
  const eanRef = (key: string) => ref(RESOURCE.ean, key);
  const accountRef = (key: string) => ref(RESOURCE.account, key);
  return {
    tenants: [{ key: PF, name: 'Preflight fixtures' }],
    instances: [
      instance(RESOURCE.organization, 'pf-org-verified', PF, { ownership_verified: true }),
      instance(RESOURCE.organization, 'pf-org-unverified', PF, { ownership_verified: false }),
      instance(RESOURCE.ean, 'PF-E1', PF),
      instance(RESOURCE.ean, 'PF-E2', PF),
      instance(RESOURCE.account, 'PF-A1', PF),
      instance(RESOURCE.account, 'PF-A2', PF),
      instance(RESOURCE.location, 'PF-L1', PF),
      instance(RESOURCE.location, 'PF-L2', PF),
      instance(RESOURCE.shipment, 'PF-S1', PF),
      instance(RESOURCE.shipment, 'PF-S2', PF),
      instance(RESOURCE.onboardingQueue, 'pf-queue', PF),
    ],
    tuples: [
      parentTuple(eanRef('PF-E1'), ref(RESOURCE.shipment, 'PF-S1'), PF), parentTuple(eanRef('PF-E2'), ref(RESOURCE.shipment, 'PF-S2'), PF),
      parentTuple(eanRef('PF-E1'), accountRef('PF-A1'), PF), parentTuple(eanRef('PF-E2'), accountRef('PF-A2'), PF),
      parentTuple(accountRef('PF-A1'), ref(RESOURCE.location, 'PF-L1'), PF), parentTuple(accountRef('PF-A2'), ref(RESOURCE.location, 'PF-L2'), PF),
    ],
    users: [
      PF_ADMIN_OK,
      adminFixture('pf-admin-suspended', { risk_state: 'suspended' }),
      adminFixture('pf-admin-dup', { duplicate_check: 'suspected' }),
      adminFixture('pf-admin-unverified', { identity_verified: false }),
      ...collaboratorFixtures(now),
      fixtureUser('pf-ean-admin', {}),
      fixtureUser('pf-pending', {}),
      fixtureUser('pf-reviewer', {}),
      adminFixture('pf-org-admin'),
      fixtureUser('pf-connector', {}),
    ],
    assignments: [
      ...['pf-admin-ok', 'pf-admin-suspended', 'pf-admin-dup', 'pf-admin-unverified'].map((user) => ({ user, role: ROLE.orgAdmin, tenant: PF })),
      { user: 'pf-ean-admin', role: ROLE.accountAdmin, tenant: PF, resource_instance: eanRef('PF-E1') },
      { user: 'pf-pending', role: ROLE.pendingMember, tenant: PF },
      { user: 'pf-reviewer', role: ROLE.onboardingReviewer, tenant: PF },
      { user: 'pf-org-admin', role: ROLE.orgAdmin, tenant: PF },
      { user: 'pf-connector', role: ROLE.integrationClient, tenant: PF, resource_instance: eanRef('PF-E1') },
      { user: 'pf-connector', role: ROLE.integrationReader, tenant: PF, resource_instance: eanRef('PF-E2') },
    ],
  };
}

/**
 * One row of the expectation matrix. A deny proves nothing while the PDP has not loaded the user yet, so the deny
 * rows whose user appears in no allow row carry a `witness`: a check on the same user and resource that must allow
 * in the same pass. Row 5's witness is what makes the bypass guard real: the PDP knows the user holds org_admin.
 */
export interface MatrixRow extends CheckSpec { n: number; expect: boolean; note?: string; witness?: { action: string; extra?: Attributes } }

const org = (key: string) => ({ type: RESOURCE.organization, key, tenant: PF });
const shipment = (key: string) => ({ type: RESOURCE.shipment, key, tenant: PF });
const ean = (key: string) => ({ type: RESOURCE.ean, key, tenant: PF });
const location = (key: string) => ({ type: RESOURCE.location, key, tenant: PF });
const SEES_PROFILE = { action: 'view_profile' };

export const MATRIX: MatrixRow[] = [
  { n: 1, user: 'pf-admin-ok', action: 'manage_members', ...org('pf-org-verified'), expect: true },
  { n: 2, user: 'pf-admin-ok', action: 'manage_members', ...org('pf-org-unverified'), expect: false },
  { n: 3, user: 'pf-admin-suspended', action: 'manage_members', ...org('pf-org-verified'), expect: false, witness: SEES_PROFILE },
  { n: 4, user: 'pf-admin-dup', action: 'manage_members', ...org('pf-org-verified'), expect: false, witness: SEES_PROFILE },
  { n: 5, user: 'pf-admin-unverified', action: 'manage_members', ...org('pf-org-verified'), expect: false, note: 'bypass guard', witness: SEES_PROFILE },
  { n: 6, user: 'pf-collab-active', action: 'view', ...shipment('PF-S1'), expect: true },
  { n: 7, user: 'pf-collab-active', action: 'view', ...shipment('PF-S2'), expect: false },
  { n: 8, user: 'pf-collab-expired', action: 'view', ...shipment('PF-S1'), expect: false,
    witness: { action: 'request_renewal', extra: { requested_days: 7 } } },
  { n: 9, user: 'pf-collab-renewable', action: 'request_renewal', ...shipment('PF-S1'), extra: { requested_days: 7 }, expect: true },
  { n: 10, user: 'pf-collab-renewable', action: 'request_renewal', ...shipment('PF-S1'), extra: { requested_days: 31 }, expect: false },
  { n: 11, user: 'pf-collab-maxed', action: 'request_renewal', ...shipment('PF-S1'), extra: { requested_days: 7 }, expect: false,
    witness: { action: 'view' } },
  { n: 12, user: 'pf-ean-admin', action: 'view', ...shipment('PF-S1'), expect: true },
  { n: 13, user: 'pf-ean-admin', action: 'view', ...shipment('PF-S2'), expect: false },
  { n: 14, user: 'pf-pending', action: 'view_own_request', ...org('pf-org-verified'), expect: true },
  { n: 15, user: 'pf-pending', action: 'manage_members', ...org('pf-org-verified'), expect: false },
  { n: 16, user: 'pf-reviewer', action: 'review', type: RESOURCE.onboardingQueue, key: 'pf-queue', tenant: PF, expect: true },
  // S2: an EAN admin grants inside their own EAN and nowhere else; the org admin grants anywhere in the tenant.
  { n: 17, user: 'pf-ean-admin', action: 'grant_shipper', ...ean('PF-E1'), expect: true },
  { n: 18, user: 'pf-ean-admin', action: 'grant_shipper', ...ean('PF-E2'), expect: false },
  { n: 19, user: 'pf-ean-admin', action: 'grant_location_operator', ...location('PF-L1'), expect: true, note: 'derived twice' },
  { n: 20, user: 'pf-org-admin', action: 'grant_location_operator', ...location('PF-L2'), expect: true },
  // S5: integration_client allows create_shipment on its EAN only; integration_reader allows view and not create_shipment.
  { n: 21, user: 'pf-connector', action: 'create_shipment', ...ean('PF-E1'), expect: true },
  { n: 22, user: 'pf-connector', action: 'create_shipment', ...ean('PF-E2'), expect: false, witness: { action: 'view' } },
];

export function matrixRow(n: number): MatrixRow {
  const row = MATRIX.find((r) => r.n === n);
  if (!row) throw new Error(`No preflight matrix row ${n}`);
  return row;
}
