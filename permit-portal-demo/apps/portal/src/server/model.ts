import { readFileSync } from 'node:fs';

export const TENANT = { shire: 'shire-freight', rohan: 'riders-of-rohan', rohanLlc: 'riders-of-rohan-llc', operator: 'great-eagle', preflight: 'preflight' } as const;
export const RESOURCE = {
  organization: 'organization', ean: 'ean', shipment: 'shipment', onboardingQueue: 'onboarding_queue',
  account: 'account', location: 'location',
} as const;
export const ROLE = {
  pendingMember: 'pending_member', orgMember: 'org_member', orgAdmin: 'org_admin', onboardingReviewer: 'onboarding_reviewer', accountAdmin: 'account_admin',
  shipper: 'shipper', accountManager: 'account_manager', locationOperator: 'location_operator',
  integrationClient: 'integration_client', integrationReader: 'integration_reader', developer: 'developer',
} as const;
export const QUEUE_KEY = 'first-admin';
export const RENEWAL_LIMIT = 2; // used in the condition as a constant: never 0 or 1
export const MAX_RENEWAL_DAYS = 30;

export interface TrustFacts { identity_verified: boolean; duplicate_check: 'clear' | 'suspected' | 'confirmed'; risk_state: 'ok' | 'suspended' }
export interface CollaboratorGrant { resource: string; role: 'collaborator'; expires: number; renewals_used: number }
export interface UserAttributes extends Partial<TrustFacts> { time_based_grants?: CollaboratorGrant[]; [k: string]: unknown }
export type RequestType = 'collaborator_invite' | 'renewal' | 'first_admin' | 'member_invite' | 'admin_transfer' | 'ean_association' | 'integration_access';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'canceled' | 'revoked' | 'expired';
export interface HistoryEntry { at: string; status: RequestStatus; by: string; comment?: string }
export interface DemoRequest {
  id: string; type: RequestType; tenant: string; target: string; role?: string;
  requested_for: string; initiated_by: string; reason?: string; duration_ms?: number; requested_days?: number; org_name?: string;
  status: RequestStatus; reviewer?: string; reviewer_comment?: string; created_at: string; updated_at: string; history: HistoryEntry[];
}
export interface SeedPersona { key: string; name: string; company: string; title: string; facts: TrustFacts | null }
/** A child account under an EAN. */
export interface SeedAccount { key: string; name: string; ean: string }
/** An operational location under a child account. */
export interface SeedLocation { key: string; name: string; account: string }
/** A row of S8's legacy billing app's own users table: `accounts` holds EAN and child-account codes. */
export interface LegacyUser { key: string; name: string; is_admin: boolean; accounts: string[]; note: string }
export interface SeedData {
  personas: SeedPersona[];
  organizations: Array<{ key: string; name: string; ownership_verified: boolean; in_permit: 'seed' | 'reset' | 'live' }>;
  eans: Array<{ key: string; org: string; in_permit: boolean; association_proof?: string }>;
  accounts: SeedAccount[];
  locations: SeedLocation[];
  shipments: Array<{ key: string; ean: string; tenant: string; title: string }>;
  requests: Array<Omit<DemoRequest, 'created_at' | 'updated_at' | 'history'> & { created_offset_ms: number }>;
  legacy: { users: LegacyUser[] };
}

/** Reads the demo data shared by the portal, the scripts and the mock (demo-data/seed.json at the repo root). */
export function loadSeed(): SeedData {
  return JSON.parse(readFileSync(new URL('../../../../demo-data/seed.json', import.meta.url), 'utf8')) as SeedData;
}
