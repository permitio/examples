import express, { type Request, type Response } from 'express';
import { CleanupJob, DEFAULT_CLEANUP_INTERVAL_MS } from '#src/cleanup-job';
import { CONSOLE_HTML } from '#src/console';
import { renderS2Console, s2ConsoleRouter } from '#src/console-s2';
import { renderS5Console } from '#src/console-s5';
import { renderS8Console } from '#src/console-s8';
import { answerErrors, type Body, HttpError, jsonBody, text } from '#src/http';
import type { NotifyResult, PortalNotifier } from '#src/portal-notifier';
import type { RequestStatus, RequestType } from '#src/requests';
import { s5Router } from '#src/routes-s5';
import { s8Router } from '#src/routes-s8';
import { loadSeed, type SeedData, type TrustFacts } from '#src/seed';
import type { NewRequest, Store } from '#src/store';

export interface AppDeps {
  store: Store;
  notifier: PortalNotifier;
  now: () => number;
  /** The scheduled job (index.ts starts it). Defaults to a stopped job at the default interval. */
  cleanup?: CleanupJob;
  /**
   * The portal, as these systems reach it: S5 runs the connector against its integration API.
   * Defaults to http://localhost:3000.
   */
  portalUrl?: string;
  /** The demo data: S8's legacy users and the child accounts. Defaults to demo-data/seed.json. */
  seed?: SeedData;
  /**
   * Where S8's legacy app finds its Permit settings (PERMIT_API_URL, PERMIT_API_KEY,
   * PERMIT_PDP_URL); index.ts passes process.env. Defaults to none, so a test never reaches a real
   * Permit.
   */
  env?: NodeJS.ProcessEnv;
}

const REQUEST_TYPES: readonly RequestType[] = [
  'collaborator_invite',
  'renewal',
  'first_admin',
  'member_invite',
  'admin_transfer',
  'ean_association',
  'integration_access',
];
const REQUEST_STATUSES: readonly RequestStatus[] = [
  'pending',
  'approved',
  'denied',
  'canceled',
  'revoked',
  'expired',
];
const DUPLICATE_CHECKS: readonly TrustFacts['duplicate_check'][] = [
  'clear',
  'suspected',
  'confirmed',
];
const RISK_STATES: readonly TrustFacts['risk_state'][] = ['ok', 'suspended'];
const NEW_REQUEST_FIELDS = [
  'type',
  'tenant',
  'target',
  'role',
  'requested_for',
  'initiated_by',
  'reason',
  'duration_ms',
  'requested_days',
  'org_name',
];

function optionalText(body: Body, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  return value;
}

function optionalCount(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new HttpError(400, `${field} must be a positive integer`);
  return value;
}

function flag(body: Body, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return value;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (!allowed.some((option) => option === value))
    throw new HttpError(400, `${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function found<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new HttpError(404, message);
  return value;
}

/** A query parameter as a list, since it may repeat. Empty values count as absent. */
function queryList(req: Request, name: string): string[] {
  const raw = req.query[name];
  const values: unknown[] = Array.isArray(raw) ? raw : [raw];
  return values.filter((value): value is string => typeof value === 'string' && value !== '');
}

function factsPatch(body: Body): Partial<TrustFacts> {
  return {
    ...(body['identity_verified'] !== undefined
      ? { identity_verified: flag(body, 'identity_verified') }
      : {}),
    ...(body['duplicate_check'] !== undefined
      ? { duplicate_check: oneOf('duplicate_check', body['duplicate_check'], DUPLICATE_CHECKS) }
      : {}),
    ...(body['risk_state'] !== undefined
      ? { risk_state: oneOf('risk_state', body['risk_state'], RISK_STATES) }
      : {}),
  };
}

function newRequest(body: Body): NewRequest {
  return {
    type: oneOf('type', body['type'], REQUEST_TYPES),
    tenant: text(body, 'tenant'),
    target: text(body, 'target'),
    requested_for: text(body, 'requested_for'),
    initiated_by: text(body, 'initiated_by'),
    role: optionalText(body, 'role'),
    reason: optionalText(body, 'reason'),
    org_name: optionalText(body, 'org_name'),
    duration_ms: optionalCount(body, 'duration_ms'),
    requested_days: optionalCount(body, 'requested_days'),
  };
}

/**
 * Answers with `saved` once the portal has confirmed the change, or 502 with the reason when it has
 * not. The change stays saved either way; repeating the PUT notifies the portal again.
 */
async function sendOnceNotified(
  res: Response,
  notified: Promise<NotifyResult>,
  saved: object,
): Promise<void> {
  const result = await notified.catch((error: unknown): NotifyResult => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  if ('error' in result) {
    res.status(502).json({ error: `Saved, but the portal did not confirm it: ${result.error}` });
    return;
  }
  res.json(saved);
}

/**
 * The Great Eagle systems mock: trust service, account master, workflow store, documents and
 * notifications, plus S5's connector registry and S8's legacy billing app, and the presenter
 * console's pages.
 */
export function createApp({
  store,
  notifier,
  now,
  cleanup = new CleanupJob(DEFAULT_CLEANUP_INTERVAL_MS, notifier, now),
  portalUrl = 'http://localhost:3000',
  seed = loadSeed(),
  env = {},
}: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.sendStatus(200);
  });
  app.get('/', (_req, res) => {
    res.type('html').send(CONSOLE_HTML);
  });
  // The scenario pages of the presenter console, linked from its header.
  app.get('/s2', (_req, res) => {
    res.type('html').send(renderS2Console());
  });
  app.get('/s5', (_req, res) => {
    res.type('html').send(renderS5Console());
  });
  app.get('/s8', (_req, res) => {
    res.type('html').send(renderS8Console());
  });

  // Trust service: users. The list feeds the presenter console.
  app.get('/api/trust/users', (_req, res) => {
    res.json(store.users());
  });
  app.get('/api/trust/users/:key', (req, res) => {
    res.json(found(store.userFacts(req.params.key), `${req.params.key} has no trust facts`));
  });
  app.put('/api/trust/users/:key', async (req, res) => {
    const patch = factsPatch(jsonBody(req, ['identity_verified', 'duplicate_check', 'risk_state']));
    const facts = found(
      store.updateUserFacts(req.params.key, patch),
      `${req.params.key} has no trust facts`,
    );
    await sendOnceNotified(res, notifier.factsChanged('user', req.params.key), facts);
  });

  // Trust service: organizations.
  app.get('/api/trust/orgs', (_req, res) => {
    res.json(store.orgs());
  });
  app.get('/api/trust/orgs/:key', (req, res) => {
    res.json(found(store.org(req.params.key), `No organization ${req.params.key}`));
  });
  app.post('/api/trust/orgs', (req, res) => {
    const body = jsonBody(req, ['key', 'name']);
    const { org, created } = store.createOrg(text(body, 'key'), text(body, 'name'));
    res.status(created ? 201 : 200).json(org);
  });
  app.put('/api/trust/orgs/:key', async (req, res) => {
    const ownership = flag(jsonBody(req, ['ownership_verified']), 'ownership_verified');
    const org = found(
      store.updateOrg(req.params.key, ownership),
      `No organization ${req.params.key}`,
    );
    await sendOnceNotified(res, notifier.factsChanged('org', req.params.key), org);
  });

  // Account master.
  app.get('/api/accounts/eans', (req, res) => {
    res.json(store.eans(queryList(req, 'org')));
  });
  app.post('/api/accounts/eans/:ean/associate', (req, res) => {
    const body = jsonBody(req, ['org', 'proof', 'by']);
    res.json(
      store.associateEan(
        req.params.ean,
        { org: text(body, 'org'), proof: text(body, 'proof'), by: text(body, 'by') },
        now(),
      ),
    );
  });

  // Workflow: the approval records.
  app.get('/api/requests', (req, res) => {
    res.json(
      store.requests({
        status: queryList(req, 'status').map((value) => oneOf('status', value, REQUEST_STATUSES)),
        type: queryList(req, 'type').map((value) => oneOf('type', value, REQUEST_TYPES)),
        tenant: queryList(req, 'tenant'),
        requested_for: queryList(req, 'requested_for'),
        initiated_by: queryList(req, 'initiated_by'),
      }),
    );
  });
  app.get('/api/requests/:id', (req, res) => {
    res.json(found(store.request(req.params.id), `No request ${req.params.id}`));
  });
  app.post('/api/requests', (req, res) => {
    res.status(201).json(store.createRequest(newRequest(jsonBody(req, NEW_REQUEST_FIELDS)), now()));
  });
  app.post('/api/requests/:id/transition', (req, res) => {
    const body = jsonBody(req, ['to', 'by', 'comment', 'duration_ms']);
    const move = {
      to: oneOf('to', body['to'], REQUEST_STATUSES),
      by: text(body, 'by'),
      comment: optionalText(body, 'comment'),
      duration_ms: optionalCount(body, 'duration_ms'),
    };
    res.json(
      found(store.transitionRequest(req.params.id, move, now()), `No request ${req.params.id}`),
    );
  });

  // Documents and notifications.
  app.get('/api/shipments/:key/documents', (req, res) => {
    res.json(store.documents(req.params.key));
  });
  app.post('/api/shipments/:key/documents', (req, res) => {
    const body = jsonBody(req, ['name', 'by']);
    res
      .status(201)
      .json(
        store.addDocument(
          req.params.key,
          { name: text(body, 'name'), by: text(body, 'by') },
          now(),
        ),
      );
  });
  app.get('/api/notifications/:user', (req, res) => {
    res.json(store.notifications(req.params.user));
  });
  app.post('/api/notifications', (req, res) => {
    const body = jsonBody(req, ['user', 'text']);
    res
      .status(201)
      .json(store.addNotification({ user: text(body, 'user'), text: text(body, 'text') }, now()));
  });

  // Cleanup job.
  app.get('/api/cleanup/status', (_req, res) => {
    res.json(cleanup.status());
  });
  app.post('/api/cleanup/run', async (_req, res) => {
    const result = await cleanup.runNow();
    if ('error' in result) {
      res.status(502).json({ error: `Cleanup did not run: ${result.error}` });
      return;
    }
    res.json({ removed: result.removed });
  });

  app.post('/api/admin/reset', (_req, res) => {
    store.reset(now());
    cleanup.reset();
    res.json({ ok: true });
  });

  // S5: the connector registry and the shipments it creates (/api/integrations…, /api/shipments).
  app.use(s5Router({ store, portalUrl, now }));
  // S8: the legacy billing app (/api/legacy/…).
  app.use(s8Router({ store, seed, env, now }));
  // S2: the console's forged-grant tester (/api/s2/forged-grant), which calls the portal
  // server-side.
  app.use(s2ConsoleRouter({ portalUrl }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such route' });
  });

  // Every router's refusals and failures, answered in one place.
  app.use(answerErrors);

  return app;
}
