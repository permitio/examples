import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Thrown when a setting the app needs is missing; the message says how to fix it. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

const IN_MEMORY = ':memory:';

/** The SQLite file that holds the app's users and sessions (`:memory:` in tests). */
export function databasePath(): string {
  return process.env['DATABASE_PATH'] ?? '.data/auth.db';
}

/** The file next to the database where `pnpm run setup` stores the session-signing secret. */
export function authSecretPath(): string {
  return join(dirname(databasePath()), 'auth-secret');
}

/** The secret Better Auth signs sessions with: `BETTER_AUTH_SECRET`, or the file setup created. */
export function authSecret(): string {
  const fromEnv = process.env['BETTER_AUTH_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (databasePath() === IN_MEMORY) {
    throw new ConfigError('BETTER_AUTH_SECRET must be set when DATABASE_PATH is :memory:.');
  }
  try {
    return readFileSync(authSecretPath(), 'utf8').trim();
  } catch (error) {
    throw new ConfigError(
      `No session secret at ${authSecretPath()}. Run \`pnpm run setup\` first (it creates one), ` +
        'or set BETTER_AUTH_SECRET.',
      { cause: error },
    );
  }
}

/** The address users open the app at. Better Auth accepts sign-in requests only from it. */
export function appUrl(): string {
  return process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000';
}

export interface PermitSettings {
  token: string;
  apiUrl: string;
  pdp: string;
}

/** Where the Permit SDK sends data changes (the API) and permission checks (the PDP). */
export function permitSettings(): PermitSettings {
  const token = process.env['PERMIT_API_KEY'];
  if (token === undefined || token === '') {
    throw new ConfigError(
      "PERMIT_API_KEY is not set. Copy .env.example to .env and add your Permit environment's " +
        'API key.',
    );
  }
  return {
    token,
    apiUrl: process.env['PERMIT_API_URL'] ?? 'https://api.permit.io',
    pdp: process.env['PERMIT_PDP_URL'] ?? 'http://localhost:7766',
  };
}
