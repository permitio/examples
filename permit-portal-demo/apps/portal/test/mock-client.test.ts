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
async function startMock(routes: Record<string, { status: number; body?: unknown }>): Promise<{ client: MockClient; seen: Seen[]; url: string }> {
  const seen: Seen[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    seen.push({ method: req.method, url: req.originalUrl, body: req.body });
    const reply = routes[`${req.method} ${req.path}`] ?? { status: 404, body: { error: 'Not found' } };
    if (reply.body === undefined) res.sendStatus(reply.status);
    else res.status(reply.status).json(reply.body);
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { client: new MockClient(url), seen, url };
}

const request = { id: 'req-1', type: 'collaborator_invite', tenant: 'shire-freight', target: 'shipment:SHP-77001', requested_for: 'aragorn', initiated_by: 'frodo', status: 'pending', created_at: 't0', updated_at: 't0', history: [] };

describe('MockClient', () => {
  it('reads trust facts, and answers null for a persona without facts', async () => {
    const facts = { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' };
    const { client } = await startMock({ 'GET /api/trust/users/eowyn': { status: 200, body: facts } });
    await expect(client.getUserFacts('eowyn')).resolves.toEqual(facts);
    await expect(client.getUserFacts('gandalf')).resolves.toBeNull();
  });

  it('lists requests with every filter, repeating type', async () => {
    const { client, seen } = await startMock({ 'GET /api/requests': { status: 200, body: [request] } });
    await expect(client.listRequests({ status: 'pending', type: ['collaborator_invite', 'renewal'], tenant: 'shire-freight', requested_for: 'aragorn' })).resolves.toEqual([request]);
    expect(seen[0]?.url).toBe('/api/requests?status=pending&type=collaborator_invite&type=renewal&tenant=shire-freight&requested_for=aragorn');
  });

  it('posts a transition with who and why', async () => {
    const { client, seen } = await startMock({ 'POST /api/requests/req-1/transition': { status: 200, body: { ...request, status: 'approved' } } });
    await expect(client.transition('req-1', 'approved', 'sam', 'ok')).resolves.toMatchObject({ status: 'approved' });
    expect(seen[0]).toEqual({ method: 'POST', url: '/api/requests/req-1/transition', body: { to: 'approved', by: 'sam', comment: 'ok' } });
  });

  it('files a request with exactly the fields the contract accepts, even when handed more', async () => {
    const { client, seen } = await startMock({ 'POST /api/requests': { status: 201, body: request } });
    const fields = { type: 'collaborator_invite' as const, tenant: 'shire-freight', target: 'shipment:SHP-77001', role: 'collaborator', requested_for: 'aragorn', initiated_by: 'frodo', reason: 'customs clearance', duration_ms: 120_000 };
    const withExtras = { ...fields, id: 'req-x', status: 'approved' as const, reviewer: 'sam', created_at: 't0', history: [] };
    await client.createRequest(withExtras);
    expect(seen[0]?.body).toEqual(fields);
  });

  it("passes the mock's 409 through with its own text", async () => {
    const { client } = await startMock({ 'POST /api/requests/req-1/transition': { status: 409, body: { error: 'Cannot move a approved request to approved' } } });
    const error = await client.transition('req-1', 'approved', 'sam').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409, message: 'Cannot move a approved request to approved' });
  });

  it('maps any other failure answer to 502', async () => {
    const { client } = await startMock({ 'POST /api/requests': { status: 500, body: { error: 'disk full' } } });
    const error = await client.createRequest({ type: 'renewal', tenant: 't', target: 'shipment:S', requested_for: 'aragorn', initiated_by: 'aragorn' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 502, message: 'Great Eagle systems mock answered 500: disk full' });
  });

  it('maps an unexpected 404 to 502 where a missing record is not an answer', async () => {
    const { client } = await startMock({});
    await expect(client.cleanupStatus()).rejects.toMatchObject({ status: 502 });
  });

  it('reports an unreachable mock as 502 with the reason', async () => {
    const { client } = await startMock({});
    await new Promise((resolve) => servers.pop()?.close(resolve));
    const error = await client.getUserFacts('eowyn').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 502, message: expect.stringMatching(/^Great Eagle systems mock is unreachable: .+/) });
  });

  it('adds a document and a notification', async () => {
    const doc = { name: 'invoice.pdf', by: 'aragorn', at: '2026-10-04T12:00:00.000Z' };
    const { client, seen } = await startMock({ 'POST /api/shipments/SHP-77001/documents': { status: 201, body: doc }, 'POST /api/notifications': { status: 201 } });
    await expect(client.addDocument('SHP-77001', 'invoice.pdf', 'aragorn')).resolves.toEqual(doc);
    await expect(client.notify('frodo', 'hello')).resolves.toBeUndefined();
    expect(seen.map((s) => s.body)).toEqual([{ name: 'invoice.pdf', by: 'aragorn' }, { user: 'frodo', text: 'hello' }]);
  });
});
