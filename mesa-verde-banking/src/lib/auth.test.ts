import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAuthSecret, loadAuthSecret } from '@/lib/auth';

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'mesa-verde-auth-'));
}

describe('the Better Auth secret', () => {
  it('comes from BETTER_AUTH_SECRET when it is set', () => {
    const env = { BETTER_AUTH_SECRET: 'from-env', DATABASE_PATH: join(dataDir(), 'db') };
    ensureAuthSecret(env);
    expect(loadAuthSecret(env)).toBe('from-env');
  });

  it('is generated once next to the database, readable only by its owner', () => {
    const env = { DATABASE_PATH: join(dataDir(), 'data', 'mesa-verde.db') };
    ensureAuthSecret(env);
    const secret = loadAuthSecret(env);
    ensureAuthSecret(env);
    expect(loadAuthSecret(env)).toBe(secret);
    expect(secret).toMatch(/^[\w-]{43}$/);
    const path = join(env.DATABASE_PATH, '..', 'auth-secret');
    expect(readFileSync(path, 'utf8')).toBe(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('says to run setup when there is none', () => {
    const env = { DATABASE_PATH: join(dataDir(), 'mesa-verde.db') };
    expect(() => loadAuthSecret(env)).toThrow('Run the setup first');
  });
});
