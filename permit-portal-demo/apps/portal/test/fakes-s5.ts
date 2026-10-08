// Test doubles for S5, an integration acting for a customer: a PDP that decides from the roles the fake Permit
// holds, the world S5 starts from, and the calls a test makes as a persona or as the connector. Great Eagle's systems, as
// the connector registry and the shipment store, are FakeMock's (fakes.ts).
import type { Express } from 'express';
import request from 'supertest';
import type { DemoRequest } from '../src/server/model';
import { harness } from './fakes';

export const SHIRE = 'shire-freight';
/** The connector Pippin registers: the key and name the portal's form is prefilled with. */
export const KEY = 'shire-erp';
export const NAME = 'Shire ERP connector';

type World = ReturnType<typeof harness>;

/**
 * Decides every check from the roles the fake Permit holds right now, as the seeded policy does for S5: a developer may
 * register_integration, the organization admin may approve_integration on an EAN of the tenant, and on an EAN the
 * connector's roles allow create_shipment (integration_client) and view (either role). Everything else is denied.
 */
export function followPolicy(h: Pick<World, 'pdp' | 'permit'>): void {
  h.pdp.rule = (user, action, resource) => {
    const tenant = resource.tenant ?? '';
    const on = `${resource.type}:${resource.key}`;
    const holds = (role: string, instance?: string) => h.permit.holds(user, role, tenant, instance);
    switch (`${resource.type}:${action}`) {
      case 'organization:register_integration':
        return holds('developer');
      case 'ean:approve_integration':
        return holds('org_admin') && h.permit.instances.has(on);
      case 'ean:create_shipment':
        return holds('integration_client', on);
      case 'ean:view':
        return holds('integration_client', on) || holds('integration_reader', on) || holds('account_admin', on);
      default:
        return false;
    }
  };
}

/**
 * The world S5 starts from: Pippin is a developer, Sam the organization admin and Frodo the admin of EAN-1001 only, the
 * sandbox EAN exists, and the PDP follows the policy ({@link followPolicy}).
 */
export function s5World() {
  const h = harness();
  h.permit.instances.set('ean:EAN-SANDBOX', { key: 'EAN-SANDBOX', resource: 'ean', tenant: SHIRE, attributes: { id: 'EAN-SANDBOX', association_verified: true } });
  h.permit.roles.push(
    { user: 'pippin', role: 'developer', tenant: SHIRE },
    { user: 'frodo', role: 'account_admin', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
  );
  followPolicy(h);
  return h;
}

/** A check the portal recorded for `user` at `at` (epoch ms), as the decision panel's feed holds it. `resource` is `type:key`. */
export function recordCheck(h: Pick<World, 'events'>, c: { user: string; action: string; resource: string; allow: boolean; at: number }): void {
  const colon = c.resource.indexOf(':');
  h.events.push({
    kind: 'check', at: c.at, user: c.user, action: c.action, resource: c.resource, tenant: SHIRE, source: 'action', allow: c.allow, ms: 1,
    input: { user: { key: c.user }, action: c.action, resource: { type: c.resource.slice(0, colon), key: c.resource.slice(colon + 1), tenant: SHIRE } },
  });
}

/** The writes the decision panel shows, in order, each with whether the PDP confirmed it. */
export const writesOf = (h: Pick<World, 'events'>) => h.events.since(0).flatMap((e) => (e.kind === 'write' ? [{ what: e.what, ok: e.ok }] : []));

export const as = (app: Express, persona: string) => ({
  get: (path: string) => request(app).get(path).set('x-demo-persona', persona),
  post: (path: string, body: object = {}) => request(app).post(path).set('x-demo-persona', persona).send(body),
});

/** The connector's side: the integration API, called with a client secret and no persona. */
export const asConnector = (app: Express, secret: string) => ({
  get: (path: string) => request(app).get(path).set('authorization', `Bearer ${secret}`),
  post: (path: string, body: object = {}) => request(app).post(path).set('authorization', `Bearer ${secret}`).send(body),
});

/** Pippin registers the connector as the page does, and answers its client secret, which only that answer carries. */
export async function register(h: Pick<World, 'app'>, key = KEY, name = NAME): Promise<string> {
  const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key, name });
  if (res.status !== 201) throw new Error(`registering ${key} answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.client_secret as string;
}

/** Pippin asks for production scope on `ean` for the connector, and answers the request filed. */
export async function askForProduction(h: Pick<World, 'app'>, key = KEY, ean = 'EAN-1001', reason = 'Create shipments from the ERP'): Promise<DemoRequest> {
  const res = await as(h.app, 'pippin').post(`/api/s5/integrations/${key}/production-requests`, { ean, reason });
  if (res.status !== 201) throw new Error(`the production request answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as DemoRequest;
}

/** The whole route to production: Pippin registers and asks, and Sam approves. Answers the connector's client secret. */
export async function approvedForProduction(h: Pick<World, 'app'>, key = KEY, ean = 'EAN-1001'): Promise<string> {
  const secret = await register(h, key);
  const filed = await askForProduction(h, key, ean);
  const approval = await as(h.app, 'sam').post(`/api/requests/${filed.id}/approve`);
  if (approval.status !== 200) throw new Error(`the approval answered ${approval.status}: ${JSON.stringify(approval.body)}`);
  return secret;
}
