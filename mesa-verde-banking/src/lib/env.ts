import { dirname, join } from 'node:path';

/** Environment variables, as `process.env` holds them. */
export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_PERMIT_API_URL = 'https://api.permit.io';
const DEFAULT_PDP_URL = 'http://localhost:7766';
const DEFAULT_DATABASE_PATH = 'data/mesa-verde.db';
const DEFAULT_ELEMENTS_URL = 'https://embed.permit.io';
const DEFAULT_APP_URL = 'http://localhost:3000';

/** A variable's value, or undefined when it is unset or blank. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** A required variable's value; throws with the variable's name when it is missing. */
export function required(env: Env, name: string): string {
  const value = read(env, name);
  if (value === undefined) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function withoutTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export interface PermitSettings {
  apiKey: string;
  apiUrl: string;
  pdpUrl: string;
}

export function permitSettings(env: Env = process.env): PermitSettings {
  return {
    apiKey: required(env, 'PERMIT_API_KEY'),
    apiUrl: withoutTrailingSlash(read(env, 'PERMIT_API_URL') ?? DEFAULT_PERMIT_API_URL),
    pdpUrl: withoutTrailingSlash(read(env, 'PERMIT_PDP_URL') ?? DEFAULT_PDP_URL),
  };
}

/** The SQLite file that holds Better Auth's tables and the demo customers. */
export function databasePath(env: Env = process.env): string {
  return read(env, 'DATABASE_PATH') ?? DEFAULT_DATABASE_PATH;
}

/** Where the generated Better Auth secret is kept when BETTER_AUTH_SECRET is not set. */
export function authSecretPath(env: Env = process.env): string {
  return join(dirname(databasePath(env)), 'auth-secret');
}

/** The app's own URL, as the browser reaches it. */
export function appUrl(env: Env = process.env): string {
  return withoutTrailingSlash(read(env, 'BETTER_AUTH_URL') ?? DEFAULT_APP_URL);
}

/** The public URL Permit can reach the app at, if one is set. Enables the approval webhook. */
export function publicUrl(env: Env = process.env): string | undefined {
  const url = read(env, 'PUBLIC_URL');
  return url === undefined ? undefined : withoutTrailingSlash(url);
}

/** The bearer token Permit sends with the approval webhook, if the webhook is set up. */
export function webhookSecret(env: Env = process.env): string | undefined {
  return read(env, 'WEBHOOK_SECRET');
}

export interface ElementsSettings {
  /** Where the browser loads the Elements iframes from. */
  embedUrl: string;
  /** The Permit API URL as the browser reaches it, passed to permit-js as `permitApiUrl`. */
  apiUrl: string;
}

export function elementsSettings(env: Env = process.env): ElementsSettings {
  const apiUrl = read(env, 'PERMIT_ELEMENTS_API_URL') ?? read(env, 'PERMIT_API_URL');
  return {
    embedUrl: withoutTrailingSlash(read(env, 'PERMIT_ELEMENTS_URL') ?? DEFAULT_ELEMENTS_URL),
    apiUrl: withoutTrailingSlash(apiUrl ?? DEFAULT_PERMIT_API_URL),
  };
}
