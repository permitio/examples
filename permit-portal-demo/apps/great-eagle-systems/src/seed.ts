import { readFileSync } from 'node:fs';
import type { DemoRequest } from '#src/requests';

// The mock's own copies of the seed types. Keep them identical in shape to
// apps/portal/src/server/model.ts.
export interface TrustFacts {
  identity_verified: boolean;
  duplicate_check: 'clear' | 'suspected' | 'confirmed';
  risk_state: 'ok' | 'suspended';
}
export interface SeedPersona {
  key: string;
  name: string;
  company: string;
  title: string;
  facts: TrustFacts | null;
}
/** A child account under an EAN. */
export interface SeedAccount {
  key: string;
  name: string;
  ean: string;
}
/** An operational location under a child account. */
export interface SeedLocation {
  key: string;
  name: string;
  account: string;
}
/** A row of S8's legacy billing app's own users table: `accounts` holds EAN and child-account codes. */
export interface LegacyUser {
  key: string;
  name: string;
  is_admin: boolean;
  accounts: string[];
  note: string;
}
export interface SeedData {
  personas: SeedPersona[];
  organizations: Array<{
    key: string;
    name: string;
    ownership_verified: boolean;
    in_permit: 'seed' | 'reset' | 'live';
  }>;
  eans: Array<{ key: string; org: string; in_permit: boolean; association_proof?: string }>;
  accounts: SeedAccount[];
  locations: SeedLocation[];
  shipments: Array<{ key: string; ean: string; tenant: string; title: string }>;
  requests: Array<
    Omit<DemoRequest, 'created_at' | 'updated_at' | 'history'> & { created_offset_ms: number }
  >;
  legacy: { users: LegacyUser[] };
}

/**
 * Reads the demo data shared by the portal, the scripts and the mock (demo-data/seed.json at the
 * repo root).
 */
export function loadSeed(): SeedData {
  return JSON.parse(
    readFileSync(new URL('../../../demo-data/seed.json', import.meta.url), 'utf8'),
  ) as SeedData;
}
