// S5 in Great Eagle's systems: the connector registry that issues and resolves client credentials,
// the call that runs the connector against the portal's integration API, the shipments the
// connector creates, and the console's /s5 page. The portal is a stub on a free local port.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Script } from 'node:vm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '#src/app';
import type { PortalNotifier } from '#src/portal-notifier';
import { loadSeed } from '#src/seed';
import { Store } from '#src/store';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');
const notifier: PortalNotifier = {
  factsChanged: async () => ({ ok: true }),
  runCleanup: async () => ({ removed: 0 }),
};
const connector = {
  key: 'shire-erp',
  name: 'Shire ERP connector',
  owner: 'pippin',
  customer: 'shire-freight',
};
const UNKNOWN = { error: 'Unknown client credential' };

function setup(portalUrl?: string) {
  const store = new Store(loadSeed(), { at: NOW });
  const app = createApp({
    store,
    notifier,
    now: () => NOW,
    ...(portalUrl === undefined ? {} : { portalUrl }),
  });
  return { app, store };
}

/**
 * Registers a connector through the API and answers the client secret, which only that answer
 * carries.
 */
async function register(
  app: ReturnType<typeof setup>['app'],
  body: object = connector,
): Promise<string> {
  const res = await request(app).post('/api/integrations').send(body);
  expect(res.status).toBe(201);
  return res.body.client_secret as string;
}

interface Received {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}
type Answer = (received: Received) => { status: number; body: unknown };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/**
 * A stand-in for the portal's integration API on a free local port, answering each request with
 * `answer`.
 */
async function portalStub(answer: Answer) {
  const received: Received[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const seen: Received = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    };
    received.push(seen);
    const { status, body } = answer(seen);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  closers.push(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close };
}

describe('the connector registry', () => {
  it('the secret is returned once and resolves', async () => {
    const { app } = setup();
    const first = await request(app).post('/api/integrations').send(connector);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ...connector, client_secret: expect.any(String) });
    // The answer that carries the secret must not be kept by a cache.
    expect(first.headers['cache-control']).toBe('no-store');
    const secret = first.body.client_secret as string;
    expect(secret.length).toBeGreaterThanOrEqual(32);

    const second = await request(app)
      .post('/api/integrations')
      .send({ ...connector, key: 'other-erp', name: 'Other ERP' });
    const otherSecret = second.body.client_secret as string;
    expect(otherSecret).not.toBe(secret);

    // Each credential resolves to its own connector, and to the customer it acts for.
    const resolved = await request(app)
      .post('/api/integrations/resolve')
      .send({ client_secret: secret });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({ key: 'shire-erp', customer: 'shire-freight' });
    expect(
      (await request(app).post('/api/integrations/resolve').send({ client_secret: otherSecret }))
        .body,
    ).toEqual({ key: 'other-erp', customer: 'shire-freight' });

    // After the registration answer, no read shows a secret.
    const listed = await request(app).get('/api/integrations');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        key: 'shire-erp',
        name: 'Shire ERP connector',
        owner: 'pippin',
        customer: 'shire-freight',
        created_at: expect.any(String),
      },
      {
        key: 'other-erp',
        name: 'Other ERP',
        owner: 'pippin',
        customer: 'shire-freight',
        created_at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(JSON.stringify(listed.body)).not.toContain(otherSecret);
  });

  it.each([
    ['an empty credential', { client_secret: '' }],
    ['no credential', {}],
    ['a credential that is not text', { client_secret: 42 }],
    ['a credential nobody holds', { client_secret: 'f'.repeat(64) }],
  ])('resolve answers 401 for %s, never a connector', async (_name, body) => {
    const { app } = setup();
    await register(app);
    const res = await request(app).post('/api/integrations/resolve').send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(UNKNOWN);
  });

  it('resolve tells a credential apart from the same letters in another case, and from a prefix of it', async () => {
    const { app } = setup();
    const secret = await register(app);
    const wrong = {
      'in capitals': secret.toUpperCase(),
      'one character short': secret.slice(0, -1),
      'one character long': `${secret}0`,
    };
    for (const [how, client_secret] of Object.entries(wrong)) {
      const res = await request(app).post('/api/integrations/resolve').send({ client_secret });
      expect(res.status, how).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(client_secret);
    }
  });

  it('registration refuses a key the pattern forbids, a taken key and a secret the caller picked, and registers nothing', async () => {
    const { app } = setup();
    for (const key of ['Shire ERP', 'shire_erp', 'ab', 'a'.repeat(41), '', ' shire-erp']) {
      expect(
        (
          await request(app)
            .post('/api/integrations')
            .send({ ...connector, key })
        ).status,
        JSON.stringify(key),
      ).toBe(400);
    }
    for (const bad of [
      { name: '' },
      { name: 'n'.repeat(81) },
      { owner: '' },
      { customer: '' },
      { name: 7 },
    ]) {
      expect(
        (
          await request(app)
            .post('/api/integrations')
            .send({ ...connector, ...bad })
        ).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    // The credential is Great Eagle's to issue: a body that brings its own is refused, not
    // honoured.
    const own = await request(app)
      .post('/api/integrations')
      .send({ ...connector, client_secret: 'a'.repeat(64) });
    expect(own.status).toBe(400);
    expect(own.body).toEqual({ error: 'Unknown field: client_secret' });
    expect((await request(app).post('/api/integrations').send([connector])).status).toBe(400);
    expect((await request(app).get('/api/integrations')).body).toEqual([]);

    const secret = await register(app);
    const again = await request(app)
      .post('/api/integrations')
      .send({ ...connector, name: 'Impostor' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).not.toContain(secret);
    // The first connector is untouched, and still the one its credential resolves to.
    expect((await request(app).get('/api/integrations')).body).toEqual([
      expect.objectContaining({ key: 'shire-erp', name: 'Shire ERP connector' }),
    ]);
    expect(
      (await request(app).post('/api/integrations/resolve').send({ client_secret: secret })).status,
    ).toBe(200);
  });

  it('registers a key of the shortest and the longest length the pattern allows', async () => {
    const { app } = setup();
    await register(app, { ...connector, key: 'abc' });
    await register(app, { ...connector, key: 'a'.repeat(39) + '9' });
    await register(app, { ...connector, key: 'x-0', name: 'n'.repeat(80) });
    expect((await request(app).get('/api/integrations')).body).toHaveLength(3);
  });
});

describe('running the connector against the portal', () => {
  it('run calls the portal with the stored secret', async () => {
    const created = {
      key: 'SHP-80001',
      ean: 'EAN-1001',
      title: 'Created by Shire ERP connector',
      created_by: 'shire-erp',
      created_at: 't',
    };
    const portal = await portalStub((r) =>
      r.method === 'POST'
        ? { status: 201, body: created }
        : { status: 200, body: { shipments: [created] } },
    );
    const { app } = setup(`${portal.url}/`);
    const secret = await register(app);

    const create = await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'create', ean: 'EAN-1001' });
    expect(create.status).toBe(200);
    expect(create.body).toEqual({ status: 201, body: created });
    const list = await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'list', ean: 'EAN-1001' });
    expect(list.body).toEqual({ status: 200, body: { shipments: [created] } });
    // The EAN is the caller's each time: the same operations on other EANs ask the portal about
    // those.
    await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'create', ean: 'EAN-1002' });
    await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'list', ean: 'EAN-SANDBOX' });

    expect(portal.received).toEqual([
      {
        method: 'POST',
        url: '/api/integration/shipments',
        authorization: `Bearer ${secret}`,
        body: { ean: 'EAN-1001', title: 'Created by Shire ERP connector' },
      },
      {
        method: 'GET',
        url: '/api/integration/shipments?ean=EAN-1001',
        authorization: `Bearer ${secret}`,
        body: undefined,
      },
      {
        method: 'POST',
        url: '/api/integration/shipments',
        authorization: `Bearer ${secret}`,
        body: { ean: 'EAN-1002', title: 'Created by Shire ERP connector' },
      },
      {
        method: 'GET',
        url: '/api/integration/shipments?ean=EAN-SANDBOX',
        authorization: `Bearer ${secret}`,
        body: undefined,
      },
    ]);
    // The secret goes to the portal and nowhere else: not back to the console.
    expect(JSON.stringify([create.body, list.body])).not.toContain(secret);
  });

  it("answers the portal's refusal verbatim, status and body, so the console can show it", async () => {
    const denial = { error: 'Permit denied create_shipment on ean:EAN-1002.', decision: 'deny' };
    const portal = await portalStub(() => ({ status: 403, body: denial }));
    const { app } = setup(portal.url);
    await register(app);
    const res = await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'create', ean: 'EAN-1002' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 403, body: denial });
  });

  it('refuses an unknown connector, an unknown operation, a missing EAN and an EAN that is not a key, without calling the portal', async () => {
    const portal = await portalStub(() => ({ status: 200, body: {} }));
    const { app } = setup(portal.url);
    await register(app);
    const run = (key: string, body: object) =>
      request(app).post(`/api/integrations/${key}/run`).send(body);
    expect((await run('nobody', { op: 'list', ean: 'EAN-1001' })).status).toBe(404);
    expect((await run('shire-erp', { op: 'delete', ean: 'EAN-1001' })).status).toBe(400);
    expect((await run('shire-erp', { ean: 'EAN-1001' })).status).toBe(400);
    expect((await run('shire-erp', { op: 'list' })).status).toBe(400);
    expect((await run('shire-erp', { op: 'list', ean: 'EAN-1001&ean=EAN-1002' })).status).toBe(400);
    expect((await run('shire-erp', { op: 'list', ean: 'EAN-1001', secret: 'x' })).status).toBe(400);
    expect(portal.received).toEqual([]);
  });

  it('says the portal did not answer, with 502 and without the secret', async () => {
    const gone = await portalStub(() => ({ status: 200, body: {} }));
    await gone.close();
    const { app } = setup(gone.url);
    const secret = await register(app);
    const res = await request(app)
      .post('/api/integrations/shire-erp/run')
      .send({ op: 'list', ean: 'EAN-1001' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: expect.stringContaining('portal') });
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });
});

describe('the shipments connectors create', () => {
  it('numbers them on from SHP-80001 and lists them per EAN, without touching the documents route', async () => {
    const { app } = setup();
    const first = await request(app)
      .post('/api/shipments')
      .send({ ean: 'EAN-1001', title: 'Pallets for Bywater', created_by: 'shire-erp' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      key: 'SHP-80001',
      ean: 'EAN-1001',
      title: 'Pallets for Bywater',
      created_by: 'shire-erp',
      created_at: expect.any(String),
    });
    const second = await request(app)
      .post('/api/shipments')
      .send({ ean: 'EAN-SANDBOX', title: 'Test', created_by: 'shire-erp' });
    expect(second.body.key).toBe('SHP-80002');
    expect((await request(app).get('/api/shipments?ean=EAN-1001')).body).toEqual([first.body]);
    expect((await request(app).get('/api/shipments?ean=EAN-1002')).body).toEqual([]);
    expect((await request(app).get('/api/shipments/SHP-77001/documents')).status).toBe(200);
  });

  it('refuses a shipment with a missing field, an oversized title or an EAN that is not a key, and a list without an EAN', async () => {
    const { app } = setup();
    const post = (body: object) => request(app).post('/api/shipments').send(body);
    const ok = { ean: 'EAN-1001', title: 'Pallets', created_by: 'shire-erp' };
    for (const bad of [
      { ean: undefined },
      { title: undefined },
      { created_by: undefined },
      { title: '   ' },
      { title: 't'.repeat(201) },
      { ean: 'EAN 1001/../x' },
      { ean: 'e'.repeat(65) },
    ]) {
      expect((await post({ ...ok, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post({ ...ok, key: 'SHP-1' })).status).toBe(400);
    expect((await request(app).get('/api/shipments')).status).toBe(400);
    expect((await request(app).get('/api/shipments?ean=EAN-1001&ean=EAN-1002')).status).toBe(400);
    expect((await request(app).get('/api/shipments?ean=EAN-1001')).body).toEqual([]);
    expect((await post({ ...ok, title: 't'.repeat(200) })).status).toBe(201);
  });
});

describe("the systems' clock", () => {
  // Every record these systems keep is dated by the app's clock, as the requests are: the portal's
  // "recent calls" cut-off reads a connector's created_at, and a test that fixes the clock must be
  // able to fix that date too.
  it("dates a registration and a created shipment by the app's clock, not the wall clock", async () => {
    const { app } = setup();
    await register(app);
    expect((await request(app).get('/api/integrations')).body).toEqual([
      expect.objectContaining({ key: 'shire-erp', created_at: new Date(NOW).toISOString() }),
    ]);
    const created = await request(app)
      .post('/api/shipments')
      .send({ ean: 'EAN-1001', title: 'Pallets', created_by: 'shire-erp' });
    expect(created.body.created_at).toBe(new Date(NOW).toISOString());
  });
});

describe('the S5 console page', () => {
  it('offers the connector three runs, and its script is valid', async () => {
    const { app } = setup();
    const res = await request(app).get('/s5');
    expect(res.status).toBe(200);
    for (const label of ['Create on EAN-1001', 'Create on EAN-1002', 'List on EAN-1001'])
      expect(res.text).toContain(label);
    // The page's script lives in a template literal, where a stray "${" or backslash changes it
    // silently: it must still parse.
    const script = /<script>([\s\S]*?)<\/script>/i.exec(res.text)?.[1] ?? '';
    expect(script).not.toBe('');
    expect(() => new Script(script)).not.toThrow();
  });
});
