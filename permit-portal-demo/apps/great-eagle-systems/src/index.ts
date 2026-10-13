// Entry point of the Great Eagle systems mock. Inside Compose, docker-compose.yml sets every
// variable read here.
import { createApp } from '#src/app';
import { CleanupJob, DEFAULT_CLEANUP_INTERVAL_MS } from '#src/cleanup-job';
import { HttpPortalNotifier } from '#src/portal-notifier';
import { loadSeed } from '#src/seed';
import { Store } from '#src/store';

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Invalid ${name}: expected a positive integer`);
  return value;
}

const port = positiveInt('PORT', 4100);
const intervalMs = positiveInt('CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS);
const portalUrl = process.env['PORTAL_INTERNAL_URL'] || 'http://localhost:3000';
const storePath = process.env['STORE_PATH'] || undefined; // unset: the state lives in memory only
const now = () => Date.now();

const seed = loadSeed();
const store = new Store(seed, { path: storePath });
const notifier = new HttpPortalNotifier(portalUrl);
const cleanup = new CleanupJob(intervalMs, notifier, now);
// S8's legacy app reads its Permit settings (PERMIT_API_URL, PERMIT_API_KEY, PERMIT_PDP_URL) from
// the environment.
const app = createApp({ store, notifier, now, cleanup, portalUrl, seed, env: process.env });

app.listen(port, (error) => {
  if (error) throw error;
  cleanup.start();
  console.log(
    `great-eagle-systems listening on :${port} (store ${storePath ?? 'in memory'}, portal ${portalUrl}, cleanup every ${intervalMs} ms)`,
  );
});
