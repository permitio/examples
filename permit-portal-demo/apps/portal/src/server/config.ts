export interface PermitSettings { apiUrl: string; apiKey: string; pdpUrl: string; proxyFacts: boolean }
export type WriteMode = 'fast' | 'waited';
export interface PortalConfig {
  profile: string; port: number; permit: PermitSettings; writes: WriteMode; greatEagleSystemsUrl: string;
  demoClockEnabled: boolean; grantDemoDurationMs: number; permitAppUrl: string;
}

const REQUIRED_HINTS = {
  PERMIT_API_URL: 'set it in profiles/<profile>.env',
  PERMIT_API_KEY: 'set it in profiles/<profile>.env',
  PROFILE: 'run through bin/demo so the profile is loaded',
} as const;

// Error messages name the variable only, never a value: the env holds the API key.
function required(env: NodeJS.ProcessEnv, name: keyof typeof REQUIRED_HINTS): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}: ${REQUIRED_HINTS[name]}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}: expected a positive integer`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase();
  if (!raw) return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`Invalid ${name}: expected true or false`);
  return raw === 'true';
}

function writeMode(env: NodeJS.ProcessEnv): WriteMode {
  const raw = env['PERMIT_WRITES']?.toLowerCase() || 'fast';
  if (raw !== 'fast' && raw !== 'waited') throw new Error('Invalid PERMIT_WRITES: expected fast or waited');
  return raw;
}

/** The portal's settings. Inside Compose they come from docker-compose.yml and the profile bin/demo loads. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PortalConfig {
  const apiUrl = required(env, 'PERMIT_API_URL');
  const apiKey = required(env, 'PERMIT_API_KEY');
  const profile = required(env, 'PROFILE');
  const writes = writeMode(env);
  return {
    profile,
    port: positiveInt(env, 'PORT', 3000),
    // fast: writes go straight to the control plane and are confirmed by reading them back from the PDP (PdpSync).
    // waited: writes go through the PDP, which answers once it has applied them. Both say "confirmed by the local PDP".
    permit: { apiUrl, apiKey, pdpUrl: env['PERMIT_PDP_URL'] || 'http://localhost:7766', proxyFacts: writes === 'waited' },
    writes,
    greatEagleSystemsUrl: env['GREAT_EAGLE_SYSTEMS_URL'] || 'http://localhost:4100',
    demoClockEnabled: bool(env, 'DEMO_CLOCK_ENABLED', false),
    grantDemoDurationMs: positiveInt(env, 'GRANT_DEMO_DURATION_MS', 120000),
    permitAppUrl: env['PERMIT_APP_URL'] || 'https://app.permit.io',
  };
}
