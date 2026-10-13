import type { Permit } from 'permitio';
import { TENANT } from '#src/server/model';
import { actsFor } from '#src/server/routes/s5';
import { ignoreNotFound, type Log, logged } from '#scripts/lib/admin';

/** The Permit API's largest page of users. */
const PAGE_SIZE = 100;
/** More pages than any demo environment has: past them the list cannot be trusted to have been read whole. */
const MAX_PAGES = 100;

/**
 * Whether a Permit user is a connector, as registration writes it (routes/s5.ts): marked `principal_type: 'integration'`
 * for the customer Shire Freight. Both marks are needed. The preflight's connector (`pf-connector`) has no attributes and is
 * not one, and neither is a user that carries only one of them.
 */
const isConnector = (attributes: unknown) => actsFor(attributes, TENANT.shire);

/**
 * The key of every connector in Permit, read page by page until a page brings no user not seen before. A list that goes on
 * past {@link MAX_PAGES} is an error: a reset that read only part of it would leave a connector, and its scope, behind.
 */
async function connectorKeys(permit: Permit): Promise<string[]> {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Permit read: a page of Permit's users with their attributes (api.users.list), `page` counted from 1.
    const { data } = await permit.api.users.list({ page, perPage: PAGE_SIZE });
    const fresh = data.filter((user) => !seen.has(user.key));
    if (fresh.length === 0) return keys;
    for (const user of fresh) {
      seen.add(user.key);
      if (isConnector(user.attributes)) keys.push(user.key);
    }
  }
  throw new Error(`Permit still lists users after ${MAX_PAGES} pages of ${PAGE_SIZE}, so the connectors among them cannot all be found`);
}

/**
 * Undoes what S5 changed in Permit: every connector goes, and with it every role it was given. Great Eagle's
 * systems clear the connectors' credentials, their requests and their shipments in their own reset. reset.ts calls it once
 * the demo data is restored. A connector already gone is fine (Permit's 404); any other failure stops the reset, since a
 * connector left behind would keep its production scope.
 */
export async function resetS5(permit: Permit, log: Log): Promise<void> {
  const keys = await connectorKeys(permit);
  if (keys.length === 0) await logged(log, 'S5, no connector', async () => 'absent');
  for (const key of keys) {
    await logged(log, `S5, the connector ${key}`, async () =>
      // Permit write: the connector deleted, together with its role assignments (api.users.delete).
      (await ignoreNotFound(() => permit.api.users.delete(key))) === 'done' ? 'deleted' : 'absent');
  }
}
