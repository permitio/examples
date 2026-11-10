import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { migrateCustomers } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import { appUrl, authSecretPath, publicUrl, type Env } from '@/lib/env';

/**
 * The email-OTP plugin's HTTP endpoints. The app only sends and checks codes from its own API
 * routes (the wire transfer step-up), so none of them is reachable from the browser: that keeps the
 * plugin from adding a passwordless sign-in or a password reset.
 */
const EMAIL_OTP_PATHS = [
  '/email-otp/change-email',
  '/email-otp/check-verification-otp',
  '/email-otp/request-email-change',
  '/email-otp/request-password-reset',
  '/email-otp/reset-password',
  '/email-otp/send-verification-otp',
  '/email-otp/verify-email',
  '/forget-password/email-otp',
  '/sign-in/email-otp',
];

/** How long a transfer code stays valid, in seconds. */
export const OTP_LIFETIME_SECONDS = 300;

/**
 * Delivers a one-time code. There is no mail server in this example, so the code goes to the app's
 * log; a real bank would email or text it.
 */
function logOneTimeCode(data: { email: string; otp: string }): Promise<void> {
  console.info(
    `[email-otp] One-time code for ${data.email}: ${data.otp} ` +
      `(valid for ${OTP_LIFETIME_SECONDS / 60} minutes)`,
  );
  return Promise.resolve();
}

export interface AuthSettings {
  db: DatabaseSync;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

function authOptions({ db, secret, baseURL, trustedOrigins }: AuthSettings) {
  return {
    appName: 'Mesa Verde Bank',
    database: db,
    secret,
    baseURL,
    trustedOrigins,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    disabledPaths: EMAIL_OTP_PATHS,
    plugins: [
      emailOTP({
        disableSignUp: true,
        storeOTP: 'hashed',
        expiresIn: OTP_LIFETIME_SECONDS,
        sendVerificationOTP: logOneTimeCode,
      }),
    ],
  } satisfies BetterAuthOptions;
}

function createAuth(settings: AuthSettings) {
  return betterAuth(authOptions(settings));
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The Better Auth secret: BETTER_AUTH_SECRET, or else the one setup generated next to the database,
 * so that a Permit API key is all an example run needs.
 */
export function loadAuthSecret(env: Env = process.env): string {
  const fromEnv = env['BETTER_AUTH_SECRET']?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const path = authSecretPath(env);
  if (!existsSync(path)) {
    throw new Error(
      `BETTER_AUTH_SECRET is not set and ${path} does not exist. Run the setup first ` +
        '(`docker compose up` runs it, or `pnpm demo:setup` in dev mode).',
    );
  }
  return readFileSync(path, 'utf8').trim();
}

/** Creates the generated secret if neither it nor BETTER_AUTH_SECRET exists. */
export function ensureAuthSecret(env: Env = process.env): void {
  const fromEnv = env['BETTER_AUTH_SECRET']?.trim();
  const path = authSecretPath(env);
  if ((fromEnv !== undefined && fromEnv !== '') || existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
}

function settingsFromEnv(): AuthSettings {
  const origin = publicUrl();
  return {
    db: getDatabase(),
    secret: loadAuthSecret(),
    baseURL: appUrl(),
    trustedOrigins: origin === undefined ? [] : [origin],
  };
}

/**
 * Creates or updates Better Auth's tables and the `customer` table. Run it before the first
 * getAuth(), which otherwise reports the missing tables.
 */
export async function migrateDatabase(): Promise<void> {
  const settings = settingsFromEnv();
  const { runMigrations } = await getMigrations(authOptions(settings));
  await runMigrations();
  migrateCustomers(settings.db);
}

let auth: Auth | undefined;

export function getAuth(): Auth {
  auth ??= createAuth(settingsFromEnv());
  return auth;
}
