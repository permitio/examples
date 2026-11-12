import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { appUrl, authSecret, databasePath } from '@/lib/config';
import { enrollMember } from '@/lib/members';
import { describePermitError, getPermit } from '@/lib/permit';

let database: DatabaseSync | undefined;

/** The app's SQLite database (Node's built-in `node:sqlite`), opened once per process. */
function getDatabase(): DatabaseSync {
  if (database === undefined) {
    const path = databasePath();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    database = new DatabaseSync(path);
  }
  return database;
}

function authOptions() {
  return {
    // The secret first: without one, nothing is created on disk.
    secret: authSecret(),
    database: getDatabase(),
    baseURL: appUrl(),
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    user: {
      // The profile the old app kept in its identity provider's user metadata.
      additionalFields: {
        firstName: { type: 'string', required: true },
        lastName: { type: 'string', required: true },
        phoneNumber: { type: 'string', required: true },
        dateOfBirth: { type: 'string', required: true },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Every new member is registered in Permit with the owner role on their own data. If
          // that fails, the sign-up is undone so the person can try again.
          after: async (user, context) => {
            try {
              await enrollMember(getPermit(), {
                id: user.id,
                email: user.email,
                firstName: String(user['firstName'] ?? ''),
                lastName: String(user['lastName'] ?? ''),
                phoneNumber: String(user['phoneNumber'] ?? ''),
                dateOfBirth: String(user['dateOfBirth'] ?? ''),
              });
            } catch (error) {
              console.error(
                `Could not register ${user.email} in Permit:`,
                describePermitError(error),
              );
              await context?.context.internalAdapter.deleteUser(user.id);
              throw APIError.fromStatus('BAD_GATEWAY', {
                message: 'Could not register you with Permit. Try again in a moment.',
              });
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
}

function createAuth() {
  return betterAuth(authOptions());
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth['$Infer']['Session']['user'];

let instance: Auth | undefined;

/**
 * The Better Auth instance, created on first use so that `next build` does not open the database or
 * need the secret.
 */
export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/**
 * Creates or updates Better Auth's tables. Run it before the first `getAuth()`: a new instance
 * checks the schema at once and logs an error when tables are missing.
 */
export async function migrateAuthDatabase(): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions());
  await runMigrations();
}
