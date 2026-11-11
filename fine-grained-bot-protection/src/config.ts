/** The app's settings, from its environment. Errors name a variable, never its value. */
export interface AppConfig {
  port: number;
  apiKey: string;
  pdpUrl: string;
  /** Unset: the User-Agent check classifies callers instead of Arcjet. */
  arcjetKey: string | undefined;
}

/** The setup script's settings. */
export interface SetupConfig {
  apiKey: string;
  apiUrl: string;
}

const API_KEY_HINT = 'set PERMIT_API_KEY to an environment API key from Permit (see .env.example)';

function apiKey(env: NodeJS.ProcessEnv): string {
  const value = env['PERMIT_API_KEY']?.trim();
  if (!value) throw new Error(`Missing PERMIT_API_KEY: ${API_KEY_HINT}`);
  return value;
}

function url(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  const protocol = URL.parse(value)?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new Error(`Invalid ${name}: expected an http(s) URL such as ${fallback}`);
  return value;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = env['PORT']?.trim();
  if (!raw) return 3000;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error('Invalid PORT: expected a port number from 1 to 65535');
  return value;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: port(env),
    apiKey: apiKey(env),
    pdpUrl: url(env, 'PERMIT_PDP_URL', 'http://localhost:7766'),
    arcjetKey: env['ARCJET_KEY']?.trim() || undefined,
  };
}

export function loadSetupConfig(env: NodeJS.ProcessEnv = process.env): SetupConfig {
  return {
    apiKey: apiKey(env),
    apiUrl: url(env, 'PERMIT_API_URL', 'https://api.permit.io'),
  };
}
