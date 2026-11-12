import { Permit } from 'permitio';

let client: Permit | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run the app with Docker Compose, or see .env.example.`);
  }
  return value;
}

/**
 * The app's Permit client, made on first use. Checks go to the PDP at `PERMIT_PDP_URL`; writes
 * (users, role assignments, resource instances) go to Permit's API at `PERMIT_API_URL`.
 *
 * The SDK's own logging is off: it logs every non-2xx answer as an error, including the 409s and
 * 404s the app expects. The app logs each failed call itself (`server/utils/api.ts`).
 */
export function permit(): Permit {
  client ??= new Permit({
    token: requiredEnv('PERMIT_API_KEY'),
    pdp: requiredEnv('PERMIT_PDP_URL'),
    apiUrl: process.env['PERMIT_API_URL'] || 'https://api.permit.io',
    log: { level: 'silent' },
  });
  return client;
}
