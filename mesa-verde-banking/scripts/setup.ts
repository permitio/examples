import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAuthSecret, getAuth, migrateDatabase } from '@/lib/auth';
import { getDatabase } from '@/lib/db';
import { permitSettings, publicUrl, webhookSecret } from '@/lib/env';
import { describeError } from '@/lib/http';
import { DEMO_PASSWORD, PERSONAS, SEED_TRANSACTIONS } from '@/lib/personas';
import { configureElements, type Webhook } from '@/setup/elements';
import { environmentScope, PermitRestClient, type EnvironmentScope } from '@/setup/permit-rest';
import { seedLocalUsers, seedRequests } from '@/setup/seed';
import { applySchema } from '@/setup/terraform';

/**
 * Sets up the example in the Permit environment of PERMIT_API_KEY, and the local database:
 *
 * 1. The policy schema, from main.tf with Terraform.
 * 2. The four Permit Elements, with the approval webhook when PUBLIC_URL is set.
 * 3. The demo accounts, users, roles and transactions in Permit.
 * 4. The demo users in Better Auth, and their countries and locations in the `customer` table.
 *
 * Every step can run again: Terraform keeps its state, and the API calls are upserts.
 */

const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function webhookFromEnv(): Webhook | undefined {
  const url = publicUrl();
  if (url === undefined) return undefined;
  const secret = webhookSecret();
  if (secret === undefined) {
    throw new Error(
      'PUBLIC_URL is set, so WEBHOOK_SECRET must be set too: Permit sends it as the bearer token ' +
        'of the approval webhook. Use a long random value, e.g. `openssl rand -hex 32`.',
    );
  }
  return { url: `${url}/account/webhook`, secret };
}

async function schemaExists(client: PermitRestClient, scope: EnvironmentScope) {
  const { status } = await client.send({
    method: 'GET',
    path: `/v2/schema/${scope.project}/${scope.environment}/resources/Wire_Transfer`,
    accept: [404],
  });
  return status !== 404;
}

async function main(): Promise<void> {
  const { apiKey, apiUrl } = permitSettings();
  const webhook = webhookFromEnv();
  const client = new PermitRestClient(apiUrl, apiKey);
  const scope = await environmentScope(client);
  console.info(
    `Setting up environment ${scope.environment} (project ${scope.project}) at ${apiUrl}`,
  );

  const statePath = process.env['TERRAFORM_STATE_PATH'] ?? 'terraform.tfstate';
  const stateFile = isAbsolute(statePath) ? statePath : join(EXAMPLE_DIR, statePath);
  if (!existsSync(stateFile) && (await schemaExists(client, scope))) {
    console.warn(
      `The schema is already in this environment, but there is no Terraform state at ${stateFile}. ` +
        'Skipping Terraform. To apply main.tf again, use a fresh environment.',
    );
  } else {
    console.info('Applying main.tf');
    await applySchema({ dir: EXAMPLE_DIR, statePath, apiKey, apiUrl }, process.env);
  }

  console.info(
    webhook === undefined
      ? 'Configuring Permit Elements (no PUBLIC_URL, so no approval webhook)'
      : `Configuring Permit Elements, with the approval webhook at ${webhook.url}`,
  );
  await configureElements(client, scope, webhook);

  console.info('Seeding accounts, users, roles and transactions in Permit');
  await client.sendAll(seedRequests(scope, PERSONAS, SEED_TRANSACTIONS));

  console.info('Seeding the demo users in the local database');
  ensureAuthSecret();
  await migrateDatabase();
  await seedLocalUsers(getAuth(), getDatabase(), PERSONAS, DEMO_PASSWORD);

  console.info(`Setup done. Demo users: ${PERSONAS.map(({ email }) => email).join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(`Setup failed: ${describeError(error)}`);
  process.exitCode = 1;
});
