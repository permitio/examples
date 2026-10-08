import { type RequestHandler, type Response, Router } from 'express';
import type { Deps } from '../app';
import { deniedBy, HttpError } from '../errors';
import { RESOURCE } from '../model';
import type { ResourceRef } from '../permit/enforcer';
import { isPersona } from '../personas';
import { eanKeyOf } from './s5';
import { bodyOf } from './validate';

/** What every refused credential is told: missing, malformed, unknown or not a connector's, the answer is the same. */
const UNKNOWN_CREDENTIAL = 'Unknown client credential';
const BEARER = /^Bearer\s+(\S+)$/i;
const MAX_TITLE = 200;
const SHIPMENT_FIELDS = ['ean', 'title'];

/** The connector a request authenticated as: its Permit user, its display name and the customer whose tenant it acts in. */
interface Connector { key: string; name: string; customer: string }

const isConnector = (value: unknown): value is Connector => {
  if (typeof value !== 'object' || value === null) return false;
  const { key, name, customer } = value as Record<string, unknown>;
  return typeof key === 'string' && typeof name === 'string' && typeof customer === 'string';
};

/**
 * The connector the authentication accepted for this request. Express types `res.locals` as `any`, so it is read as
 * unknown and narrowed, the way personaOf reads the persona: anything but a whole connector is a programming error here,
 * never a principal to check as.
 */
export function connectorOf(res: Response): Connector {
  const connector: unknown = res.locals.connector;
  if (!isConnector(connector)) throw new Error('connectorOf() used on a route outside the integration authentication');
  return connector;
}

function titleOf(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (title === '' || title.length > MAX_TITLE) throw new HttpError(400, `title must be 1 to ${MAX_TITLE} characters`);
  return title;
}

/**
 * The integration API: what S5's connector calls, server to server, from Great Eagle's systems.
 * app.ts mounts it at /api/integration before the persona middleware: its caller authenticates with the connector's own
 * credential, never as a persona. The credential is resolved by Great Eagle's systems, which issued it; the portal never
 * stores, logs or records it, and never answers a request whose credential it cannot place.
 */
export function integrationApiRouter(d: Deps): Router {
  const r = Router();

  // Authentication: `Authorization: Bearer <client secret>`, resolved by Great Eagle's systems to the connector it was issued
  // to. Anything else is a 401: there is no default principal, and an unreachable registry is a 502 (no answer is never "yes").
  const authenticate: RequestHandler = async (req, res, next) => {
    const refuse = () => {
      res.set('www-authenticate', 'Bearer');
      return new HttpError(401, UNKNOWN_CREDENTIAL);
    };
    const credential = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (credential === undefined) throw refuse();
    const identity = await d.mock.resolveIntegration(credential);
    // A person's key is never a connector's: a credential registered under one would otherwise be checked as that person.
    if (identity === null || isPersona(d.seed, identity.key)) throw refuse();
    const name = (await d.mock.listIntegrations()).find((i) => i.key === identity.key)?.name ?? identity.key;
    // From here the connector is the request's principal, as the persona is for the routes behind the persona middleware.
    res.locals.connector = { key: identity.key, name, customer: identity.customer } satisfies Connector;
    next();
  };
  r.use(authenticate);

  /** How the connector's routes ask Permit: as the connector, so the decision panel and Permit's Audit Log name it. */
  const enforce = async (connector: Connector, action: string, ref: ResourceRef) => {
    if (!(await d.enforcer.check(connector.key, action, ref, { source: 'action', label: connector.name }))) throw deniedBy(action, ref);
  };
  const eanRef = (connector: Connector, ean: string): ResourceRef => ({ type: RESOURCE.ean, key: ean, tenant: connector.customer });

  r.post('/shipments', async (req, res) => {
    const connector = connectorOf(res);
    const body = bodyOf(req);
    const unknown = Object.keys(body).filter((field) => !SHIPMENT_FIELDS.includes(field));
    if (unknown.length > 0) throw new HttpError(400, `Unknown field: ${unknown.join(', ')}`);
    const ean = eanKeyOf(body.ean);
    const title = titleOf(body.title);
    // Permit check: may this connector create shipments on this EAN?
    await enforce(connector, 'create_shipment', eanRef(connector, ean));
    // Great Eagle's systems are the system of record: Permit authorized the create, and stores no shipment.
    res.status(201).json(await d.mock.createShipment({ ean, title, created_by: connector.key }));
  });

  r.get('/shipments', async (req, res) => {
    const connector = connectorOf(res);
    const ean = eanKeyOf(req.query.ean);
    // Permit check: may this connector view this EAN?
    await enforce(connector, 'view', eanRef(connector, ean));
    const created = await d.mock.listShipments(ean);
    // The EAN's own shipments, then the ones connectors created.
    const own = d.seed.shipments.filter((s) => s.ean === ean && s.tenant === connector.customer).map(({ key, title }) => ({ key, ean, title }));
    res.json({ shipments: [...own, ...created] });
  });

  r.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return r;
}
