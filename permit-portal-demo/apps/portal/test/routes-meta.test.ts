import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permit } from 'permitio';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { webBuildOf } from '#src/server/app';
import { harness } from '#test/fakes';

describe('persona header', () => {
  it('rejects missing or unknown persona', async () => {
    const { app } = harness();
    for (const call of [request(app).get('/api/meta'), request(app).get('/api/meta').set('x-demo-persona', 'mallory'), request(app).post('/api/checks/bulk').send({ checks: [] })]) {
      const res = await call;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Pick a persona' });
    }
  });

  it('is not needed for the health check or the internal routes the mock calls', async () => {
    const { app } = harness();
    expect((await request(app).get('/healthz')).status).toBe(200);
    expect((await request(app).post('/internal/facts-changed').send({})).status).not.toBe(401);
  });
});

describe('GET /api/meta', () => {
  it('describes the demo: profile, clock, grant duration, the nine personas and both shipments', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/meta').set('x-demo-persona', 'aragorn');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ profile: 'test', permitAppUrl: 'https://app.permit.io', demoClock: { enabled: false, offsetMs: 0 }, grantDemoDurationMs: 120_000 });
    expect(res.body.personas.map((p: { key: string }) => p.key)).toEqual(['eowyn', 'eomer', 'grima', 'gandalf', 'sam', 'frodo', 'merry', 'pippin', 'aragorn']);
    expect(res.body.shipments.map((s: { key: string }) => s.key)).toEqual(['SHP-77001', 'SHP-77002']);
  });
});

describe('GET /api/events', () => {
  it('returns the events after the given id, and the last id', async () => {
    const { app, events } = harness();
    const first = events.push({ kind: 'write', at: 1, what: 'a', ms: 2, ok: true });
    events.push({ kind: 'write', at: 1, what: 'b', ms: 2, ok: false, error: 'boom' });
    const all = await request(app).get('/api/events?since=0').set('x-demo-persona', 'aragorn');
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ events: events.since(0), lastId: 2 });
    const newer = await request(app).get(`/api/events?since=${first}`).set('x-demo-persona', 'aragorn');
    expect(newer.body.events.map((e: { what: string }) => e.what)).toEqual(['b']);
    expect((await request(app).get('/api/events').set('x-demo-persona', 'aragorn')).body.events).toHaveLength(2);
    expect((await request(app).get('/api/events?since=x').set('x-demo-persona', 'aragorn')).status).toBe(400);
  });
});

describe('demo clock', () => {
  it('answers 409 to advance and reset when the clock is switched off', async () => {
    const { app } = harness();
    for (const path of ['/api/clock/advance', '/api/clock/reset']) {
      const res = await request(app).post(path).set('x-demo-persona', 'aragorn').send({ ms: 60_000 });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'The demo clock is switched off' });
    }
  });

  it('moves the time every check sends when switched on', async () => {
    const { app, clock } = harness({ clockEnabled: true });
    const advanced = await request(app).post('/api/clock/advance').set('x-demo-persona', 'aragorn').send({ ms: 3_600_000 });
    expect(advanced.body).toEqual({ offsetMs: 3_600_000 });
    expect(clock.now()).toBe(1_000_000 + 3_600_000);
    expect((await request(app).get('/api/meta').set('x-demo-persona', 'aragorn')).body.demoClock).toEqual({ enabled: true, offsetMs: 3_600_000 });
    expect((await request(app).post('/api/clock/advance').set('x-demo-persona', 'aragorn').send({ ms: -5 })).status).toBe(400);
    expect((await request(app).post('/api/clock/reset').set('x-demo-persona', 'aragorn')).body).toEqual({ offsetMs: 0 });
  });
});

describe('POST /api/checks/bulk', () => {
  it("answers each check in order for the caller's persona, with the measured time", async () => {
    const { app, pdp } = harness();
    pdp.rule = (user, action, r) => user === 'aragorn' && action === 'view' && r.key === 'SHP-77001';
    const res = await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({
      checks: [
        { action: 'view', resource: { type: 'shipment', key: 'SHP-77001', tenant: 'shire-freight' } },
        { action: 'view', resource: { type: 'shipment', key: 'SHP-77002', tenant: 'shire-freight' } },
        { action: 'view_profile', resource: { type: 'organization', key: 'shire-freight', tenant: 'shire-freight', attributes: { x: 1 } } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ allow: true }, { allow: false }, { allow: false }]);
    expect(res.body.ms).toEqual(expect.any(Number));
    expect(pdp.asked.map((a) => a.user)).toEqual(['aragorn', 'aragorn', 'aragorn']);
  });

  it('rejects a malformed check with 400', async () => {
    const { app } = harness();
    for (const checks of [undefined, [{ action: 'view' }], [{ action: 'view', resource: { type: 'shipment', key: 'S' } }], [{ action: 1, resource: { type: 'shipment', key: 'S', tenant: 't' } }]]) {
      const res = await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks });
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
  });
});

const view = (key: string) => ({ action: 'view', resource: { type: 'shipment', key, tenant: 'shire-freight' } });

describe('Permit reasons, on demand', () => {
  it('never asks the PDP for a reason while making decisions', async () => {
    const { app, explainer, events } = harness();
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks: [view('SHP-77001'), view('SHP-77002')] });
    expect(events.since(0)).toHaveLength(2);
    expect(explainer.inputs).toEqual([]);
    expect(events.since(0).some((e) => 'reason' in e)).toBe(false);
  });

  it("replays a check's recorded input, keeps the reason on the event and answers the replay's decision", async () => {
    const { app, explainer, events } = harness();
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks: [view('SHP-77001')] });
    const check = events.since(0)[0];
    if (check?.kind !== 'check') throw new Error('expected a check event');
    explainer.answer = { reason: { abac: { allow: true, reason: 'userset_active_5fcollaborator' } }, allow: true };
    const res = await request(app).post(`/api/events/${check.id}/explain`).set('x-demo-persona', 'frodo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: { abac: { allow: true, reason: 'userset_active_5fcollaborator' } }, allow: true });
    expect(explainer.inputs).toEqual([check.input]);
    const feed = await request(app).get('/api/events?since=0').set('x-demo-persona', 'frodo');
    expect(feed.body.events[0]).toMatchObject({ id: check.id, reason: { abac: { allow: true, reason: 'userset_active_5fcollaborator' } } });
  });

  it('keeps a failed replay as the reason, with no decision', async () => {
    const { app, explainer, events } = harness();
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks: [view('SHP-77001')] });
    explainer.answer = { reason: { error: 'PDP answered 503' }, allow: null };
    const res = await request(app).post(`/api/events/${events.lastId()}/explain`).set('x-demo-persona', 'aragorn');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: { error: 'PDP answered 503' }, allow: null });
    expect(events.get(events.lastId())).toMatchObject({ reason: { error: 'PDP answered 503' } });
  });

  it('records a user-permissions read as a read, never as a check, so it has nothing to replay', async () => {
    const { app, explainer, events } = harness();
    const read = await request(app).get('/api/s2/permissions/merry').set('x-demo-persona', 'merry');
    expect(read.status).toBe(200);
    // The feed carries it as a read: no decision, no action or resource the PDP was never asked about.
    const feed = await request(app).get('/api/events?since=0').set('x-demo-persona', 'merry');
    expect(feed.body.events).toEqual([expect.objectContaining({ kind: 'read', user: 'merry', tenants: ['shire-freight'] })]);
    expect(feed.body.events[0]).not.toHaveProperty('allow');
    // Only a check has a decision to explain, so the read meets the same 409 as a write: no special case.
    const res = await request(app).post(`/api/events/${events.lastId()}/explain`).set('x-demo-persona', 'merry');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Only checks can be explained' });
    expect(explainer.inputs).toEqual([]);
  });

  it('answers 404 Unknown event for an id the log does not hold, including one rotated out', async () => {
    const { app, events, explainer } = harness({ eventCapacity: 2 });
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks: [view('A'), view('B'), view('C')] });
    for (const id of [1, 999, 'abc']) {
      const res = await request(app).post(`/api/events/${id}/explain`).set('x-demo-persona', 'aragorn');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Unknown event' });
    }
    expect(events.get(3)).toBeDefined();
    expect(explainer.inputs).toEqual([]);
  });

  it('answers 409 for a write event', async () => {
    const { app, events, explainer } = harness();
    const id = events.push({ kind: 'write', at: 1, what: 'grant SHP-77001 (aragorn)', ms: 2, ok: true });
    const res = await request(app).post(`/api/events/${id}/explain`).set('x-demo-persona', 'aragorn');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Only checks can be explained' });
    expect(explainer.inputs).toEqual([]);
  });

  it('needs a persona like every other API route', async () => {
    const { app } = harness();
    expect((await request(app).post('/api/events/1/explain')).status).toBe(401);
  });
});

describe('event source', () => {
  it("tags the checks of a request that says x-demo-source: refresh, and everything else as the persona's action", async () => {
    const { app } = harness();
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').set('x-demo-source', 'refresh').send({ checks: [view('SHP-77001')] });
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').send({ checks: [view('SHP-77002')] });
    await request(app).post('/api/checks/bulk').set('x-demo-persona', 'aragorn').set('x-demo-source', 'something-else').send({ checks: [view('SHP-77003')] });
    const feed = await request(app).get('/api/events?since=0').set('x-demo-persona', 'aragorn');
    expect(feed.body.events.map((e: { resource: string; source: string }) => [e.resource, e.source])).toEqual([
      ['shipment:SHP-77001', 'refresh'],
      ['shipment:SHP-77002', 'action'],
      ['shipment:SHP-77003', 'action'],
    ]);
  });
});

describe('errors and unknown routes', () => {
  it('answers unknown API routes and malformed JSON with an error body', async () => {
    const { app } = harness();
    const missing = await request(app).get('/api/nothing-here').set('x-demo-persona', 'aragorn');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Not found' });
    const malformed = await request(app).post('/api/clock/advance').set('x-demo-persona', 'aragorn').set('content-type', 'application/json').send('{"ms":');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'The request body is not valid JSON' });
  });

  it('turns an unexpected failure into 500 Unexpected error', async () => {
    const { app, events } = harness();
    events.since = () => {
      throw new TypeError('kaboom');
    };
    const res = await request(app).get('/api/events?since=0').set('x-demo-persona', 'aragorn');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected error' });
  });
});

/** What the Permit SDK throws when its API gets no answer at all: no HTTP status, the network error's code. */
const unanswered = (message = 'Could not fetch the API key scope: connect ECONNREFUSED 10.0.0.9:443 Check connectivity and API key access.') =>
  Object.assign(new Error(message), { name: 'PermitContextError', code: 'ECONNREFUSED' });

describe('Permit API unreachable', () => {
  it('answers 502 with the short reason when a control-plane read gets no answer', async () => {
    const h = harness();
    h.permit.tenantsApi.get = async () => {
      throw unanswered();
    };
    const res = await request(h.app).get('/api/s1/organizations/riders-of-rohan').set('x-demo-persona', 'eowyn');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Permit API unreachable: ECONNREFUSED' });
  });

  it('answers 502 and records the same text when a waited write gets no answer', async () => {
    const h = harness();
    h.permit.failures.assignRole = Object.assign(unanswered('connect ETIMEDOUT 10.0.0.9:443'), { name: 'PermitApiError', code: 'ETIMEDOUT' });
    const res = await request(h.app).post('/api/s1/organizations').set('x-demo-persona', 'eowyn').send({ name: 'Riders of Rohan' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Permit API unreachable: ETIMEDOUT' });
    expect(h.events.since(0).at(-1)).toMatchObject({ kind: 'write', ok: false, error: 'Permit API unreachable: ETIMEDOUT' });
  });

  it('falls back to the message, with anything key- or token-like removed, when there is no network code', async () => {
    const h = harness();
    h.permit.tenantsApi.get = async () => {
      throw Object.assign(new Error('socket hang up (Authorization: Bearer permit_key_Abc123XyZ, token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl)'), { name: 'PermitApiError' });
    };
    const res = await request(h.app).get('/api/s1/organizations/riders-of-rohan').set('x-demo-persona', 'eowyn');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/^Permit API unreachable: socket hang up/);
    expect(res.body.error).not.toMatch(/permit_key_|Abc123XyZ|eyJ/);
  });

  it('maps the real SDK error for an API that refuses connections, without ever showing the key', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const sdk = new Permit({ token: 'permit_key_ThisMustNeverLeak0123', apiUrl: `http://127.0.0.1:${port}`, pdp: `http://127.0.0.1:${port}`, proxyFactsViaPdp: true, log: { level: 'silent' } });
    const real: unknown = await sdk.api.tenants.get('riders-of-rohan').then(() => undefined, (e: unknown) => e);
    // The library behaviour the mapping relies on: a named SDK error, no HTTP status, the network error's code.
    expect(real).toMatchObject({ name: 'PermitContextError', code: 'ECONNREFUSED' });
    expect((real as { status?: unknown }).status).toBeUndefined();
    const h = harness();
    h.permit.tenantsApi.get = async () => {
      throw real;
    };
    const res = await request(h.app).get('/api/s1/organizations/riders-of-rohan').set('x-demo-persona', 'eowyn');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Permit API unreachable: ECONNREFUSED' });
    expect(res.text).not.toContain('permit_key_');
  });

  it('leaves an answered Permit error and a non-SDK error alone', async () => {
    const h = harness();
    h.permit.tenantsApi.get = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); // not from the SDK
    };
    expect((await request(h.app).get('/api/s1/organizations/riders-of-rohan').set('x-demo-persona', 'eowyn')).status).toBe(500);
    h.permit.tenantsApi.get = async () => {
      throw Object.assign(new Error('Forbidden'), { name: 'PermitApiError', status: 403 }); // Permit answered
    };
    expect((await request(h.app).get('/api/s1/organizations/riders-of-rohan').set('x-demo-persona', 'eowyn')).status).toBe(500);
  });
});

describe('the web UI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Great Eagle Logistics Business Portal</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves the built files and falls back to index.html for page routes, never for the API', async () => {
    const { app } = harness({ webDir: dir });
    expect((await request(app).get('/assets/app.js')).text).toBe('console.log(1);');
    for (const path of ['/', '/shipments/SHP-77001']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Great Eagle Logistics Business Portal');
    }
    expect((await request(app).get('/api/nothing-here').set('x-demo-persona', 'aragorn')).body).toEqual({ error: 'Not found' });
    expect((await request(app).get('/internal/nothing-here')).body).toEqual({ error: 'Not found' });
    expect((await request(app).post('/shipments')).status).toBe(404);
  });

  it('still starts and serves the API when the UI has not been built', async () => {
    const { app } = harness({ webDir: join(dir, 'missing') });
    expect((await request(app).get('/')).status).toBe(404);
    const res = await request(app).get('/api/meta').set('x-demo-persona', 'aragorn');
    expect(res.status).toBe(200);
    expect(res.headers['x-portal-build']).toBeUndefined();
  });

  it('names the web build it serves on every API answer, even a refusal, so an older tab can tell it was rebuilt', async () => {
    const { app } = harness({ webDir: dir });
    const build = createHash('sha256').update(readFileSync(join(dir, 'index.html'))).digest('hex').slice(0, 12);
    expect(webBuildOf(dir)).toBe(build);
    expect((await request(app).get('/api/meta').set('x-demo-persona', 'aragorn')).headers['x-portal-build']).toBe(build);
    expect((await request(app).get('/api/meta').set('x-demo-persona', 'nobody')).headers['x-portal-build']).toBe(build);
    expect((await request(app).get('/assets/app.js')).headers['x-portal-build']).toBeUndefined();
  });
});
