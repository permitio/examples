import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { type Body, HttpError, jsonBody, text } from '#src/http';
import type { Store } from '#src/store';

/** A connector's key: lowercase letters, digits and dashes. The portal also makes it the connector's user in Permit. */
const KEY = /^[a-z0-9-]{3,40}$/;
/** An EAN key as the portal knows them (EAN-1001, EAN-SANDBOX). */
const EAN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 80;
const MAX_TITLE = 200;
const PORTAL_TIMEOUT_MS = 10_000;
const OPERATIONS = ['create', 'list'] as const;
type Operation = (typeof OPERATIONS)[number];

/** What an unknown, missing or malformed credential is told, whichever of the three it was. */
const UNKNOWN_CREDENTIAL = 'Unknown client credential';

/** A required field that must match `pattern` exactly, as given: nothing is trimmed or lowercased on the way. */
function matching(value: unknown, field: string, pattern: RegExp, expected: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `${field} must be ${expected}`);
  return value;
}

const keyOf = (body: Body) => matching(body['key'], 'key', KEY, 'lowercase letters, digits and dashes, 3 to 40 characters');
const eanOf = (value: unknown) => matching(value, 'ean', EAN, 'an EAN key such as EAN-1001');

function operationOf(body: Body): Operation {
  const found = OPERATIONS.find((op) => op === body['op']);
  if (found === undefined) throw new HttpError(400, `op must be one of ${OPERATIONS.join(', ')}`);
  return found;
}

/** Why a call to the portal got no answer: the network error's code, else its message. Never anything the call carried. */
function reasonOf(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : 'no answer';
}

/**
 * S5's part in Great Eagle's systems: the connector registry, which issues and resolves client
 * credentials, the call that runs the connector against the portal's integration API (`portalUrl`) with the stored
 * credential, and the shipments the connector creates. app.ts mounts it at the root, so its paths are whole:
 * /api/integrations… and /api/shipments. The credential lives here and nowhere else: it is answered once, at
 * registration, and sent from here to the portal; no read returns it. Records are dated by the app's clock, `now`.
 * A refusal is an HttpError, which app.ts's error handler answers.
 */
export function s5Router({ store, portalUrl, now }: { store: Store; portalUrl: string; now: () => number }): Router {
  const r = Router();
  const portal = portalUrl.replace(/\/+$/, '');

  /** One call to the portal's integration API as the connector: a POST of `body` when given, else a GET. It is answered
   * as `{ status, body }` whatever the status. */
  const callPortal = async (path: string, secret: string, body?: object): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${portal}${path}`, {
      ...(body === undefined
        ? { method: 'GET', headers: { authorization: `Bearer ${secret}` } }
        : { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new HttpError(502, `The portal did not answer: ${reasonOf(error)}`);
    });
    const raw = await res.text();
    let answer: unknown = raw;
    try {
      answer = raw === '' ? null : JSON.parse(raw);
    } catch {
      // not JSON: the text is the body
    }
    return { status: res.status, body: answer };
  };

  r.post('/api/integrations', (req, res) => {
    const body = jsonBody(req, ['key', 'name', 'owner', 'customer']);
    const key = keyOf(body);
    const secret = randomBytes(32).toString('hex');
    const integration = store.addIntegration(
      { key, name: text(body, 'name', MAX_NAME), owner: text(body, 'owner', MAX_NAME), customer: text(body, 'customer', MAX_NAME), secret }, now(),
    );
    // A taken key is refused, and the answer never carries the other connector's secret: a registration cannot read one.
    if (integration === undefined) throw new HttpError(409, `${key} is already registered`);
    // The one answer that carries the secret: nothing may keep it.
    res.status(201).set('cache-control', 'no-store').json({ key, name: integration.name, owner: integration.owner, customer: integration.customer, client_secret: secret });
  });

  r.post('/api/integrations/resolve', (req, res) => {
    const secret = jsonBody(req, ['client_secret'])['client_secret'];
    const integration = typeof secret === 'string' ? store.findIntegrationBySecret(secret) : undefined;
    if (integration === undefined) throw new HttpError(401, UNKNOWN_CREDENTIAL);
    res.json({ key: integration.key, customer: integration.customer });
  });

  r.get('/api/integrations', (_req, res) => {
    // Named field by field: the store's records carry the secret, and a field added to them later must not reach a list.
    res.json(store.listIntegrations().map(({ key, name, owner, customer, created_at }) => ({ key, name, owner, customer, created_at })));
  });

  r.post('/api/integrations/:key/run', async (req, res) => {
    const body = jsonBody(req, ['op', 'ean']);
    const op = operationOf(body);
    const ean = eanOf(body['ean']);
    const integration = store.listIntegrations().find((i) => i.key === req.params.key);
    if (integration === undefined) throw new HttpError(404, `No connector ${req.params.key}`);
    // The portal's answer goes back verbatim, status and body, so the console shows what the portal said and why.
    res.json(op === 'create'
      ? await callPortal('/api/integration/shipments', integration.secret, { ean, title: `Created by ${integration.name}` })
      : await callPortal(`/api/integration/shipments?ean=${encodeURIComponent(ean)}`, integration.secret));
  });

  // Only /api/shipments itself: /api/shipments/:key/documents belongs to the documents routes.
  r.route('/api/shipments')
    .get((req, res) => {
      res.json(store.listShipments(eanOf(req.query['ean'])));
    })
    .post((req, res) => {
      const body = jsonBody(req, ['ean', 'title', 'created_by']);
      res.status(201).json(store.addShipment({ ean: eanOf(body['ean']), title: text(body, 'title', MAX_TITLE), created_by: text(body, 'created_by', MAX_NAME) }, now()));
    });

  return r;
}
