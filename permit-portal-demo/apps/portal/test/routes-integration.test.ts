// The integration API: what S5's connector calls with its own credential, never as a persona.
// The PDP decides from the roles the fake Permit holds (fakes-s5.ts), so each answer follows from what the routes wrote.
import type { Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '#src/server/errors';
import { connectorOf } from '#src/server/routes/integration-api';
import { as, asConnector, approvedForProduction, KEY, NAME, register, s5World, SHIRE } from '#test/fakes-s5';

const SHIPMENTS = '/api/integration/shipments';
const UNKNOWN = { error: 'Unknown client credential' };
const create = (ean: string, title = 'Pallets for Bywater') => ({ ean, title });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The checks the PDP was asked, in order. */
const askedOf = (h: ReturnType<typeof s5World>) => h.pdp.asked.map((a) => `${a.user} ${a.action} ${a.resource}`);

describe('credential authentication', () => {
  it('rejects a missing or unknown credential with 401', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const checksBefore = h.pdp.asked.length;
    const headers: Array<[how: string, header: string | undefined]> = [
      ['no header', undefined],
      ['another scheme', `Basic ${secret}`],
      ['no credential', 'Bearer'],
      ['an empty credential', 'Bearer '],
      ['two credentials', `Bearer ${secret} ${secret}`],
      ['a credential nobody holds', `Bearer ${'0'.repeat(64)}`],
      ['the credential with a character added', `Bearer ${secret}0`],
      ['the credential cut short', `Bearer ${secret.slice(0, -1)}`],
      ['a credential too long to be one', `Bearer ${'a'.repeat(5_000)}`],
    ];
    for (const [how, header] of headers) {
      const calls = [
        request(h.app).post(SHIPMENTS).send(create('EAN-1001')),
        request(h.app).get(`${SHIPMENTS}?ean=EAN-1001`),
      ];
      for (const call of calls) {
        const res = await (header === undefined ? call : call.set('authorization', header));
        expect(res.status, how).toBe(401);
        expect(res.body, how).toEqual(UNKNOWN);
        // A 401 tells the caller how to authenticate.
        expect(res.headers['www-authenticate'], how).toBe('Bearer');
        // The answer does not repeat what was presented.
        expect(JSON.stringify(res.body)).not.toContain(secret);
      }
    }
    // Not one check was made, and nothing was created: a refused credential is never given a default principal.
    expect(h.pdp.asked).toHaveLength(checksBefore);
    expect(h.mock.shipments).toEqual([]);
  });

  it('a persona header is not a credential, and does not replace one', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const checksBefore = h.pdp.asked.length;
    const asSam = await request(h.app).post(SHIPMENTS).set('x-demo-persona', 'sam').send(create('EAN-1001'));
    expect(asSam.status).toBe(401);
    expect(asSam.body).toEqual(UNKNOWN);
    expect(h.pdp.asked).toHaveLength(checksBefore);

    // With the connector's credential and Sam's persona header, the connector is who is checked.
    const both = await request(h.app).post(SHIPMENTS).set('authorization', `Bearer ${secret}`).set('x-demo-persona', 'sam').send(create('EAN-1001'));
    expect(both.status).toBe(201);
    expect(askedOf(h).slice(checksBefore)).toEqual([`${KEY} create_shipment ean:EAN-1001`]);
  });

  it("refuses a credential registered under a person's key, so a connector can never act as a person", async () => {
    const h = s5World();
    // Registered at Great Eagle's systems directly, around the portal's registration route.
    const { client_secret } = await h.mock.registerIntegration({ key: 'sam', name: 'Not Sam', owner: 'pippin', customer: SHIRE });
    const checksBefore = h.pdp.asked.length;
    const res = await asConnector(h.app, client_secret).post(SHIPMENTS, create('EAN-1001'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNKNOWN);
    expect(h.pdp.asked).toHaveLength(checksBefore);
    expect(h.mock.shipments).toEqual([]);
  });

  it('fails closed when Great Eagle’s systems cannot say whose credential it is', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const checksBefore = h.pdp.asked.length;
    h.mock.resolveFailure = new HttpError(502, 'Great Eagle systems mock is unreachable: connect ECONNREFUSED');
    const res = await asConnector(h.app, secret).post(SHIPMENTS, create('EAN-1001'));
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(h.pdp.asked).toHaveLength(checksBefore);
    expect(h.mock.shipments).toEqual([]);
  });
});

describe('the connector acting for the customer', () => {
  it('an approved connector creates on EAN-1001', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const res = await asConnector(h.app, secret).post(SHIPMENTS, create('EAN-1001'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ key: 'SHP-80001', ean: 'EAN-1001', title: 'Pallets for Bywater', created_by: KEY, created_at: 't1' });
    expect(h.mock.shipments).toEqual([res.body]);
    // Permit was asked as the connector, about the EAN, in the customer's tenant, and the decision panel names the connector.
    const checks = h.events.since(0).flatMap((e) => (e.kind === 'check' && e.user === KEY ? [e] : []));
    expect(checks).toEqual([expect.objectContaining({
      user: KEY, action: 'create_shipment', resource: 'ean:EAN-1001', tenant: SHIRE, source: 'action', label: NAME, allow: true,
    })]);
  });

  it("create on EAN-1002 is 403 with Permit's denial", async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    // Sam, who approved EAN-1001, can see EAN-1002: the connector's scope is only what was approved.
    const res = await asConnector(h.app, secret).post(SHIPMENTS, create('EAN-1002'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permit denied create_shipment on ean:EAN-1002.', decision: 'deny' });
    expect(h.mock.shipments).toEqual([]);
    const list = await asConnector(h.app, secret).get(`${SHIPMENTS}?ean=EAN-1002`);
    expect(list.status).toBe(403);
    expect(list.body).toEqual({ error: 'Permit denied view on ean:EAN-1002.', decision: 'deny' });
  });

  it('before approval the connector has the sandbox only', async () => {
    const h = s5World();
    const secret = await register(h);
    const sandbox = await asConnector(h.app, secret).post(SHIPMENTS, create('EAN-SANDBOX', 'Test'));
    expect(sandbox.status).toBe(201);
    const production = await asConnector(h.app, secret).post(SHIPMENTS, create('EAN-1001'));
    expect(production.status).toBe(403);
    expect(production.body).toEqual({ error: 'Permit denied create_shipment on ean:EAN-1001.', decision: 'deny' });
    expect(h.mock.shipments.map((s) => s.ean)).toEqual(['EAN-SANDBOX']);
  });

  it('view-only: create 403, list 200', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const connector = asConnector(h.app, secret);
    expect((await connector.post(SHIPMENTS, create('EAN-1001', 'Before view-only'))).status).toBe(201);
    expect((await as(h.app, 'sam').post(`/api/s5/integrations/${KEY}/scope`, { ean: 'EAN-1001', level: 'read' })).status).toBe(200);

    const denied = await connector.post(SHIPMENTS, create('EAN-1001', 'After view-only'));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: 'Permit denied create_shipment on ean:EAN-1001.', decision: 'deny' });
    expect(h.mock.shipments).toHaveLength(1);

    const list = await connector.get(`${SHIPMENTS}?ean=EAN-1001`);
    expect(list.status).toBe(200);
    // The EAN's own shipments, then the ones connectors created.
    expect(list.body).toEqual({
      shipments: [
        { key: 'SHP-77001', ean: 'EAN-1001', title: 'International shipment, customs clearance pending' },
        { key: 'SHP-77002', ean: 'EAN-1001', title: 'Domestic shipment' },
        { key: 'SHP-80001', ean: 'EAN-1001', title: 'Before view-only', created_by: KEY, created_at: 't1' },
      ],
    });
  });

  it('a revoked connector gets 403', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const connector = asConnector(h.app, secret);
    expect((await as(h.app, 'sam').post(`/api/s5/integrations/${KEY}/scope`, { ean: 'EAN-1001', level: 'none' })).status).toBe(200);
    const created = await connector.post(SHIPMENTS, create('EAN-1001'));
    expect(created.status).toBe(403);
    expect(created.body).toEqual({ error: 'Permit denied create_shipment on ean:EAN-1001.', decision: 'deny' });
    const listed = await connector.get(`${SHIPMENTS}?ean=EAN-1001`);
    expect(listed.status).toBe(403);
    expect(listed.body).toEqual({ error: 'Permit denied view on ean:EAN-1001.', decision: 'deny' });
    expect(h.mock.shipments).toEqual([]);
    // The credential still resolves: revoking changes what Permit allows, not who the connector is.
    expect((await connector.post(SHIPMENTS, create('EAN-SANDBOX', 'Still the sandbox'))).status).toBe(201);
  });

  it('refuses a create or a list it cannot read before asking Permit, and takes the longest title the limit allows', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const connector = asConnector(h.app, secret);
    const checksBefore = h.pdp.asked.length;
    const bad = [{}, { ean: 'EAN-1001' }, { title: 'x' }, { ean: 'EAN 1001', title: 'x' }, { ean: 'EAN-1001', title: '   ' },
      { ean: 'EAN-1001', title: 'x'.repeat(201) }, { ean: ['EAN-1001'], title: 'x' }, { ean: 'EAN-1001', title: 'x', created_by: 'sam' }];
    for (const body of bad) expect((await connector.post(SHIPMENTS, body)).status, JSON.stringify(body)).toBe(400);
    for (const query of ['', '?ean=', '?ean=EAN-1001&ean=EAN-1002', '?ean=EAN%201001']) {
      expect((await connector.get(`${SHIPMENTS}${query}`)).status, query).toBe(400);
    }
    expect(h.pdp.asked).toHaveLength(checksBefore);
    expect(h.mock.shipments).toEqual([]);
    expect((await connector.post(SHIPMENTS, create('EAN-1001', 'x'.repeat(200)))).status).toBe(201);
  });

  it('answers an unknown path under the integration API with 404, not with a persona prompt', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const res = await asConnector(h.app, secret).get('/api/integration/nothing');
    expect(res.status).toBe(404);
  });
});

describe('the secret', () => {
  it('the secret never appears in events', async () => {
    const printed = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const h = s5World();
    const secret = await approvedForProduction(h);
    const connector = asConnector(h.app, secret);
    // Every call that carries or follows the secret: allowed, denied, refused, listed, changed and revoked.
    await connector.post(SHIPMENTS, create('EAN-1001'));
    await connector.post(SHIPMENTS, create('EAN-1002'));
    await connector.get(`${SHIPMENTS}?ean=EAN-1001`);
    await request(h.app).post(SHIPMENTS).set('authorization', `Bearer ${secret}0`).send(create('EAN-1001'));
    await as(h.app, 'sam').get('/api/s5/integrations');
    await as(h.app, 'sam').post(`/api/s5/integrations/${KEY}/scope`, { ean: 'EAN-1001', level: 'read' });
    await as(h.app, 'sam').post(`/api/s5/integrations/${KEY}/scope`, { ean: 'EAN-1001', level: 'none' });
    const feed = await as(h.app, 'sam').get('/api/events');

    expect(h.events.since(0).length).toBeGreaterThan(5);
    expect(JSON.stringify(h.events.since(0))).not.toContain(secret);
    expect(JSON.stringify(feed.body)).not.toContain(secret);
    // Nor in what the portal wrote to Permit, the connector's user included, nor in anything the portal printed.
    expect(JSON.stringify(h.permit.log)).not.toContain(secret);
    expect(JSON.stringify([...h.permit.attributes])).not.toContain(secret);
    for (const spy of printed) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  });
});

describe('the connector a request authenticated as', () => {
  /** A response whose locals hold `connector`, as a middleware would have left them. */
  const withLocals = (connector: unknown) => ({ locals: { connector } }) as unknown as Response;

  it('is the connector the authentication stored: key, name and customer', () => {
    expect(connectorOf(withLocals({ key: KEY, name: NAME, customer: SHIRE }))).toEqual({ key: KEY, name: NAME, customer: SHIRE });
  });

  it('is never a bare key, a part of one or nothing: those are errors, not a principal to check as', () => {
    // A key stored the way the persona middleware stores a persona would otherwise be checked as user undefined in tenant undefined.
    for (const stored of [KEY, undefined, null, { key: KEY }, { key: KEY, name: NAME }, { key: 7, name: NAME, customer: SHIRE }]) {
      expect(() => connectorOf(withLocals(stored)), JSON.stringify(stored)).toThrow('connectorOf() used on a route outside the integration authentication');
    }
  });
});
