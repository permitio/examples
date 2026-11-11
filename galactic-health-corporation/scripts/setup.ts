/**
 * One-shot setup, safe to re-run: creates the session secret and the app's database tables, writes
 * the Permit policy, then the demo members. Run: `pnpm run setup` (or the Compose `setup`
 * service).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyPolicy, type Log } from '#scripts/policy';
import { seedDemo } from '#scripts/seed';
import { getAuth, migrateAuthDatabase } from '@/lib/auth';
import { authSecretPath, permitSettings } from '@/lib/config';
import { getPermit } from '@/lib/permit';

/** Writes a random session secret next to the database, unless one exists or is set. */
function ensureAuthSecret(log: Log): void {
  if (process.env['BETTER_AUTH_SECRET']) return;
  const path = authSecretPath();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    log(`  created ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    log(`  exists  ${path}`);
  }
}

async function main(): Promise<void> {
  const log: Log = (line) => console.log(line);
  const { apiUrl } = permitSettings();
  console.log('App database');
  ensureAuthSecret(log);
  await migrateAuthDatabase();
  log('  tables are up to date');
  console.log(`Permit policy (${apiUrl})`);
  const permit = getPermit();
  await applyPolicy(permit, log);
  console.log('Demo members');
  await seedDemo(getAuth(), permit, log, new Date());
  console.log('Setup done.');
}

try {
  await main();
} catch (error) {
  console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
