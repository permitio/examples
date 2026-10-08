// MockClient's S5 calls against a stand-in for Great Eagle's systems on a free local port: the connector registry
// and the shipment store. The route tests use FakeMock, so only these tests run the real client's HTTP.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/server/errors';
import { MockClient } from '../src/server/mock-client';

interface Seen { method: string; url: string; body: unknown }

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A stand-in for the Great Eagle systems mock that answers each `METHOD /path` with a canned status and body. */
async function startMock(routes: Record<string, { status: number; body?: unknown }>): Promise<{ client: MockClient; seen: Seen[] }> {
  const seen: Seen[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    seen.push({ method: req.method, url: req.originalUrl, body: req.body });
    const reply = routes[`${req.method} ${req.path}`] ?? { status: 404, body: { error: 'Not found' } };
    res.status(reply.status).json(reply.body ?? {});
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return { client: new MockClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), seen };
}

const connector = { key: 'shire-erp', name: 'Shire ERP connector', owner: 'pippin', customer: 'shire-freight' };
const SECRET = 'c0ffee'.repeat(10);

describe('MockClient: the connector registry', () => {
  it('registers a connector with exactly its four fields and answers the client secret that comes with it', async () => {
    const { client, seen } = await startMock({ 'POST /api/integrations': { status: 201, body: { ...connector, client_secret: SECRET } } });
    // A caller that hands over more (a secret of its own, say) still sends only the four fields.
    const registered = await client.registerIntegration({ ...connector, client_secret: 'mine' } as typeof connector);
    expect(registered).toEqual({ ...connector, client_secret: SECRET });
    expect(seen).toEqual([{ method: 'POST', url: '/api/integrations', body: connector }]);
  });

  it("passes the registry's 409 for a taken key through with its own text", async () => {
    const { client } = await startMock({ 'POST /api/integrations': { status: 409, body: { error: 'shire-erp is already registered' } } });
    const error = await client.registerIntegration(connector).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409, message: 'shire-erp is already registered' });
  });

  it('lists the connectors', async () => {
    const listed = [{ ...connector, created_at: '2026-10-07T09:00:00.000Z' }];
    const { client, seen } = await startMock({ 'GET /api/integrations': { status: 200, body: listed } });
    await expect(client.listIntegrations()).resolves.toEqual(listed);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/integrations' });
  });

  it('resolves a credential to its connector, sending it in the body and nowhere in the URL', async () => {
    const { client, seen } = await startMock({ 'POST /api/integrations/resolve': { status: 200, body: { key: 'shire-erp', customer: 'shire-freight' } } });
    await expect(client.resolveIntegration(SECRET)).resolves.toEqual({ key: 'shire-erp', customer: 'shire-freight' });
    expect(seen).toEqual([{ method: 'POST', url: '/api/integrations/resolve', body: { client_secret: SECRET } }]);
  });

  it('answers null for a credential the registry refuses with 401', async () => {
    const { client } = await startMock({ 'POST /api/integrations/resolve': { status: 401, body: { error: 'Unknown client credential' } } });
    await expect(client.resolveIntegration(SECRET)).resolves.toBeNull();
  });

  it('does not take a failing or unreachable registry for an unknown credential: that is an error, never a null', async () => {
    const failing = await startMock({ 'POST /api/integrations/resolve': { status: 500, body: { error: 'disk full' } } });
    const failure = await failing.client.resolveIntegration(SECRET).catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 502, message: 'Great Eagle systems mock answered 500: disk full' });

    const gone = await startMock({});
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const unreachable = await gone.client.resolveIntegration(SECRET).catch((e: unknown) => e);
    expect(unreachable).toBeInstanceOf(HttpError);
    expect(unreachable).toMatchObject({ status: 502, message: expect.stringMatching(/^Great Eagle systems mock is unreachable: .+/) });
    // Neither error repeats the credential.
    expect(JSON.stringify([failure, (unreachable as Error).message])).not.toContain(SECRET);
  });
});

describe('MockClient: the shipments connectors create', () => {
  const shipment = { key: 'SHP-80001', ean: 'EAN-1001', title: 'Pallets', created_by: 'shire-erp', created_at: '2026-10-07T09:00:00.000Z' };

  it('creates a shipment with exactly the three fields it is given', async () => {
    const { client, seen } = await startMock({ 'POST /api/shipments': { status: 201, body: shipment } });
    const fields = { ean: 'EAN-1001', title: 'Pallets', created_by: 'shire-erp' };
    await expect(client.createShipment({ ...fields, key: 'SHP-1' } as typeof fields)).resolves.toEqual(shipment);
    expect(seen).toEqual([{ method: 'POST', url: '/api/shipments', body: fields }]);
  });

  it('lists the shipments of one EAN, with the EAN encoded as data', async () => {
    const { client, seen } = await startMock({ 'GET /api/shipments': { status: 200, body: [shipment] } });
    await expect(client.listShipments('EAN-1001')).resolves.toEqual([shipment]);
    await client.listShipments('a&b=c');
    expect(seen.map((s) => s.url)).toEqual(['/api/shipments?ean=EAN-1001', '/api/shipments?ean=a%26b%3Dc']);
  });
});
