import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { CleanupJob } from '../src/cleanup-job';
import type { CleanupResult, NotifyResult, PortalNotifier } from '../src/portal-notifier';
import { loadSeed } from '../src/seed';
import { Store } from '../src/store';

const NOW = Date.parse('2026-10-05T09:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const invite = {
  type: 'collaborator_invite', tenant: 'shire-freight', target: 'shipment:SHP-77001', role: 'collaborator',
  requested_for: 'aragorn', initiated_by: 'frodo', reason: 'customs clearance', duration_ms: 120_000,
};

function setup(answers: { notify?: NotifyResult; cleanup?: CleanupResult } = {}) {
  const clock = { now: NOW };
  const store = new Store(loadSeed(), { at: NOW });
  const calls: Array<[subject: string, key: string]> = [];
  const factsSeenByPortal: unknown[] = [];
  const notifier: PortalNotifier = {
    async factsChanged(subject, key) {
      calls.push([subject, key]);
      // The portal reads the facts back from the mock when it is notified, so they must already be saved.
      factsSeenByPortal.push(subject === 'user' ? store.userFacts(key) : store.org(key));
      return answers.notify ?? { ok: true };
    },
    async runCleanup() {
      return answers.cleanup ?? { removed: 0 };
    },
  };
  const app = createApp({ store, notifier, now: () => clock.now });
  return { app, store, clock, notifier, calls, factsSeenByPortal };
}

describe('trust service: users', () => {
  it('PUT stores the fact, notifies the portal after saving it, and a following GET shows it', async () => {
    const { app, calls, factsSeenByPortal } = setup();
    const put = await request(app).put('/api/trust/users/eowyn').send({ identity_verified: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
    const get = await request(app).get('/api/trust/users/eowyn');
    expect(get.status).toBe(200);
    expect(get.body.identity_verified).toBe(true);
    expect(calls).toEqual([['user', 'eowyn']]);
    expect(factsSeenByPortal).toEqual([{ identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' }]);
  });

  it('answers 502 with the reason when the portal was not notified, and keeps the saved fact', async () => {
    const { app } = setup({ notify: { error: 'portal answered 424: The PDP did not confirm this change within 5 seconds.' } });
    const put = await request(app).put('/api/trust/users/eowyn').send({ risk_state: 'suspended' });
    expect(put.status).toBe(502);
    expect(put.body.error).toContain('The PDP did not confirm this change within 5 seconds.');
    expect((await request(app).get('/api/trust/users/eowyn')).body.risk_state).toBe('suspended');
  });

  it.each([
    [{ duplicate_check: 'maybe' }],
    [{ identity_verified: 'yes' }],
    [{ risk_state: 'ok', time_based_grants: [] }],
  ])('rejects %j with 400, changes nothing and does not notify', async (body) => {
    const { app, calls } = setup();
    const put = await request(app).put('/api/trust/users/eowyn').send(body);
    expect(put.status).toBe(400);
    expect(put.body.error).toEqual(expect.any(String));
    expect((await request(app).get('/api/trust/users/eowyn')).body).toEqual({ identity_verified: false, duplicate_check: 'clear', risk_state: 'ok' });
    expect(calls).toEqual([]);
  });

  it.each(['gandalf', 'aragorn', 'mallory'])('answers 404 for %s, who has no trust facts', async (key) => {
    const { app, calls } = setup();
    expect((await request(app).get(`/api/trust/users/${key}`)).status).toBe(404);
    expect((await request(app).put(`/api/trust/users/${key}`).send({ identity_verified: true })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('lists every persona with facts for the console', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/trust/users');
    expect(res.status).toBe(200);
    expect(res.body.map((u: { key: string }) => u.key)).toEqual(['eowyn', 'eomer', 'grima', 'sam', 'frodo']);
    expect(res.body[0]).toEqual({ key: 'eowyn', name: 'Éowyn', facts: { identity_verified: false, duplicate_check: 'clear', risk_state: 'ok' } });
  });
});

describe('trust service: organizations', () => {
  it('POST creates an org unverified, a second POST answers 200 and leaves it unchanged', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/trust/orgs').send({ key: 'acme-freight', name: 'Acme Freight' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ key: 'acme-freight', name: 'Acme Freight', ownership_verified: false });
    await request(app).put('/api/trust/orgs/acme-freight').send({ ownership_verified: true }).expect(200);
    const again = await request(app).post('/api/trust/orgs').send({ key: 'acme-freight', name: 'Renamed' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ key: 'acme-freight', name: 'Acme Freight', ownership_verified: true });
  });

  it('PUT sets ownership_verified, then notifies the portal about the org', async () => {
    const { app, calls, factsSeenByPortal } = setup();
    const put = await request(app).put('/api/trust/orgs/riders-of-rohan').send({ ownership_verified: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ key: 'riders-of-rohan', name: 'Riders of Rohan', ownership_verified: true });
    expect(calls).toEqual([['org', 'riders-of-rohan']]);
    expect(factsSeenByPortal).toEqual([put.body]);
    expect((await request(app).get('/api/trust/orgs/riders-of-rohan')).body.ownership_verified).toBe(true);
  });

  it('answers 404 for an unknown org and 400 for a non-boolean ownership_verified', async () => {
    const { app, calls } = setup();
    expect((await request(app).get('/api/trust/orgs/nowhere')).status).toBe(404);
    expect((await request(app).put('/api/trust/orgs/nowhere').send({ ownership_verified: true })).status).toBe(404);
    expect((await request(app).put('/api/trust/orgs/riders-of-rohan').send({ ownership_verified: 'true' })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('account master', () => {
  it('lists an org’s EANs and never returns a proof', async () => {
    const { app } = setup();
    const shire = await request(app).get('/api/accounts/eans?org=shire-freight');
    expect(shire.status).toBe(200);
    expect(shire.body).toEqual([
      { key: 'EAN-1001', org: 'shire-freight' },
      { key: 'EAN-1002', org: 'shire-freight' },
      { key: 'EAN-1003', org: 'shire-freight' },
      { key: 'EAN-SANDBOX', org: 'shire-freight' },
    ]);
    // EAN-2001 is the only EAN with a proof on file, so it is the one that could leak.
    const northwind = await request(app).get('/api/accounts/eans?org=riders-of-rohan');
    expect(northwind.body).toEqual([{ key: 'EAN-2001', org: 'riders-of-rohan' }]);
    const all = await request(app).get('/api/accounts/eans');
    expect(all.body).toHaveLength(5);
    expect(all.text).not.toContain('INV-2001-0815');
  });

  it('approves an association when the proof matches and the EAN belongs to the org, and records it', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/accounts/eans/EAN-2001/associate').send({ org: 'riders-of-rohan', proof: 'INV-2001-0815', by: 'eowyn' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true, reason: expect.any(String),
      request: { type: 'ean_association', tenant: 'riders-of-rohan', target: 'ean:EAN-2001', requested_for: 'eowyn', initiated_by: 'eowyn', status: 'approved', reviewer: 'great-eagle-account-master' },
    });
    const stored = await request(app).get(`/api/requests/${res.body.request.id}`);
    expect(stored.body).toEqual(res.body.request);
    expect(stored.body.history.map((h: { status: string; by: string }) => [h.status, h.by])).toEqual([['pending', 'eowyn'], ['approved', 'great-eagle-account-master']]);
  });

  it('denies an association with the wrong proof', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/accounts/eans/EAN-2001/associate').send({ org: 'riders-of-rohan', proof: 'INV-0000-0000', by: 'eowyn' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, request: { status: 'denied', reviewer: 'great-eagle-account-master' } });
    expect(res.body.request.reviewer_comment).toBe(res.body.reason);
  });

  it('denies an association for an org that does not own the EAN, even with the right proof', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/accounts/eans/EAN-2001/associate').send({ org: 'shire-freight', proof: 'INV-2001-0815', by: 'frodo' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, reason: 'EAN-2001 does not belong to shire-freight', request: { status: 'denied' } });
  });

  it('denies an EAN that has no proof on file and an EAN that does not exist', async () => {
    const { app } = setup();
    const noProof = await request(app).post('/api/accounts/eans/EAN-1003/associate').send({ org: 'shire-freight', proof: 'anything', by: 'frodo' });
    expect(noProof.body).toMatchObject({ valid: false, request: { status: 'denied' } });
    const unknown = await request(app).post('/api/accounts/eans/EAN-9999/associate').send({ org: 'shire-freight', proof: 'anything', by: 'frodo' });
    expect(unknown.body).toMatchObject({ valid: false, request: { status: 'denied' } });
  });
});

describe('workflow: requests', () => {
  it('creates a pending request, approves it, and answers 409 for a second approval', async () => {
    const { app } = setup();
    const created = await request(app).post('/api/requests').send(invite);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      ...invite, id: expect.stringMatching(/^req-[0-9a-f]{8}$/), status: 'pending', created_at: iso(NOW), updated_at: iso(NOW),
      history: [{ at: iso(NOW), status: 'pending', by: 'frodo' }],
    });
    const path = `/api/requests/${created.body.id}/transition`;
    const first = await request(app).post(path).send({ to: 'approved', by: 'sam', comment: 'ok' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'approved', reviewer: 'sam', reviewer_comment: 'ok' });
    const second = await request(app).post(path).send({ to: 'approved', by: 'sam' });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: expect.any(String) });
    expect((await request(app).get(`/api/requests/${created.body.id}`)).body.status).toBe('approved');
  });

  it('records the duration an approver sets when approving, and only then', async () => {
    const { app } = setup();
    const { duration_ms: _ms, ...withoutDuration } = invite;
    const created = await request(app).post('/api/requests').send(withoutDuration);
    const path = `/api/requests/${created.body.id}/transition`;
    const approved = await request(app).post(path).send({ to: 'approved', by: 'sam', duration_ms: 900_000 });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', reviewer: 'sam', duration_ms: 900_000 });
    const revoked = await request(app).post(path).send({ to: 'revoked', by: 'frodo', duration_ms: 1 });
    expect(revoked.body.duration_ms).toBe(900_000);
    expect((await request(app).post(path).send({ to: 'revoked', by: 'frodo', duration_ms: 'soon' })).status).toBe(400);
  });

  it('rejects an unknown field instead of dropping it', async () => {
    const { app } = setup();
    const { duration_ms: _ms, ...rest } = invite;
    const res = await request(app).post('/api/requests').send({ ...rest, durationMs: 120_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('durationMs');
  });

  it('answers 400 for a bad transition body and 404 for an unknown request', async () => {
    const { app } = setup();
    expect((await request(app).post('/api/requests/req-grima-first-admin/transition').send({ to: 'approve', by: 'gandalf' })).status).toBe(400);
    expect((await request(app).post('/api/requests/req-grima-first-admin/transition').send({ to: 'denied' })).status).toBe(400);
    expect((await request(app).post('/api/requests/req-nope/transition').send({ to: 'denied', by: 'gandalf' })).status).toBe(404);
    expect((await request(app).get('/api/requests/req-nope')).status).toBe(404);
  });

  it('lists newest first and filters by status, tenant, people and a repeated type', async () => {
    const { app, clock } = setup();
    clock.now = NOW + 1_000;
    const a = (await request(app).post('/api/requests').send(invite)).body;
    const b = (await request(app).post('/api/requests').send({ ...invite, type: 'renewal', initiated_by: 'aragorn', duration_ms: undefined, requested_days: 7 })).body;
    const ids = async (query: string) => (await request(app).get(`/api/requests${query}`)).body.map((r: { id: string }) => r.id);
    expect(await ids('')).toEqual([b.id, a.id, 'req-grima-first-admin']);
    expect(await ids('?type=collaborator_invite&type=renewal')).toEqual([b.id, a.id]);
    expect(await ids('?type=first_admin')).toEqual(['req-grima-first-admin']);
    expect(await ids('?status=pending&tenant=riders-of-rohan-llc')).toEqual(['req-grima-first-admin']);
    expect(await ids('?requested_for=aragorn&initiated_by=frodo')).toEqual([a.id]);
    expect((await request(app).get('/api/requests?status=pendng')).status).toBe(400);
  });
});

describe('documents and notifications', () => {
  it('keeps documents per shipment', async () => {
    const { app } = setup();
    const posted = await request(app).post('/api/shipments/SHP-77001/documents').send({ name: 'commercial-invoice.pdf', by: 'aragorn' });
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ name: 'commercial-invoice.pdf', by: 'aragorn', at: iso(NOW) });
    expect((await request(app).get('/api/shipments/SHP-77001/documents')).body).toEqual([posted.body]);
    expect((await request(app).get('/api/shipments/SHP-77002/documents')).body).toEqual([]);
  });

  it('keeps notifications per user', async () => {
    const { app } = setup();
    const posted = await request(app).post('/api/notifications').send({ user: 'frodo', text: 'Expired grant removed' });
    expect(posted.status).toBe(201);
    expect(posted.body).toEqual({ user: 'frodo', text: 'Expired grant removed', at: iso(NOW) });
    expect((await request(app).get('/api/notifications/frodo')).body).toEqual([posted.body]);
    expect((await request(app).get('/api/notifications/sam')).body).toEqual([]);
  });
});

describe('admin reset', () => {
  it('restores Gríma’s pending request (created relative to now), Éowyn’s facts, the orgs, and clears the rest', async () => {
    const { app, clock } = setup();
    await request(app).put('/api/trust/users/eowyn').send({ identity_verified: true }).expect(200);
    await request(app).put('/api/trust/orgs/riders-of-rohan').send({ ownership_verified: true }).expect(200);
    await request(app).post('/api/trust/orgs').send({ key: 'acme-freight', name: 'Acme Freight' }).expect(201);
    await request(app).post('/api/requests/req-grima-first-admin/transition').send({ to: 'denied', by: 'gandalf', comment: 'duplicate' }).expect(200);
    await request(app).post('/api/requests').send(invite).expect(201);
    await request(app).post('/api/shipments/SHP-77001/documents').send({ name: 'a.pdf', by: 'aragorn' }).expect(201);
    await request(app).post('/api/notifications').send({ user: 'frodo', text: 'x' }).expect(201);

    clock.now = NOW + 3_600_000;
    expect((await request(app).post('/api/admin/reset')).status).toBe(200);

    const grima = await request(app).get('/api/requests/req-grima-first-admin');
    const createdAt = iso(NOW + 3_600_000 - 600_000);
    expect(grima.body).toEqual({
      id: 'req-grima-first-admin', type: 'first_admin', tenant: 'riders-of-rohan-llc', target: 'organization:riders-of-rohan-llc', role: 'org_admin',
      requested_for: 'grima', initiated_by: 'grima', org_name: 'Riders of Rohan LLC', status: 'pending',
      created_at: createdAt, updated_at: createdAt, history: [{ at: createdAt, status: 'pending', by: 'grima' }],
    });
    expect((await request(app).get('/api/requests')).body).toHaveLength(1);
    expect((await request(app).get('/api/trust/users/eowyn')).body.identity_verified).toBe(false);
    expect((await request(app).get('/api/trust/orgs/riders-of-rohan')).body.ownership_verified).toBe(false);
    expect((await request(app).get('/api/trust/orgs/acme-freight')).status).toBe(404);
    expect((await request(app).get('/api/shipments/SHP-77001/documents')).body).toEqual([]);
    expect((await request(app).get('/api/notifications/frodo')).body).toEqual([]);
  });
});

describe('cleanup job', () => {
  it('POST /api/cleanup/run asks the portal, and the status shows the run', async () => {
    const { app } = setup({ cleanup: { removed: 2 } });
    const run = await request(app).post('/api/cleanup/run');
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ removed: 2 });
    const status = await request(app).get('/api/cleanup/status');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ intervalMs: 600_000, lastRunAt: NOW, nextRunAt: null, lastRemoved: 2, lastError: null });
  });

  it('POST /api/cleanup/run answers 502 when the portal fails, and the status shows the error', async () => {
    const { app } = setup({ cleanup: { error: 'portal unreachable: ECONNREFUSED' } });
    const run = await request(app).post('/api/cleanup/run');
    expect(run.status).toBe(502);
    expect(run.body.error).toContain('portal unreachable: ECONNREFUSED');
    expect((await request(app).get('/api/cleanup/status')).body).toMatchObject({ lastRunAt: NOW, lastRemoved: null, lastError: 'portal unreachable: ECONNREFUSED' });
  });

  it('POST /api/admin/reset forgets the last run and restarts the countdown at the full interval', async () => {
    const { store, clock, notifier } = setup({ cleanup: { removed: 1 } });
    const cleanup = new CleanupJob(60_000, notifier, () => clock.now);
    const app = createApp({ store, notifier, now: () => clock.now, cleanup });
    cleanup.start();
    try {
      await request(app).post('/api/cleanup/run').expect(200);
      clock.now = NOW + 30_000;
      await request(app).post('/api/admin/reset').expect(200);
      expect((await request(app).get('/api/cleanup/status')).body).toEqual({ intervalMs: 60_000, lastRunAt: null, nextRunAt: NOW + 90_000, lastRemoved: null, lastError: null });
    } finally {
      cleanup.stop();
    }
  });
});

describe('persistence', () => {
  const dirs: string[] = [];
  const tempStorePath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'great-eagle-systems-'));
    dirs.push(dir);
    return { dir, path: join(dir, 'store.json') };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes every change to STORE_PATH, so a restarted mock keeps it, and leaves no temp file behind', async () => {
    const { dir, path } = tempStorePath();
    const notifier: PortalNotifier = { factsChanged: async () => ({ ok: true }), runCleanup: async () => ({ removed: 0 }) };
    const app = createApp({ store: new Store(loadSeed(), { path, at: NOW }), notifier, now: () => NOW });
    await request(app).put('/api/trust/users/eowyn').send({ risk_state: 'suspended' }).expect(200);
    const created = (await request(app).post('/api/requests').send(invite).expect(201)).body;

    const restarted = new Store(loadSeed(), { path, at: NOW + 60_000 });
    expect(restarted.userFacts('eowyn')?.risk_state).toBe('suspended');
    expect(restarted.request(created.id)).toEqual(created);
    expect(readdirSync(dir)).toEqual(['store.json']);
  });

  it('refuses to start from a store file it cannot read, rather than starting empty', () => {
    const { path } = tempStorePath();
    writeFileSync(path, '{"users": [');
    expect(() => new Store(loadSeed(), { path, at: NOW })).toThrow(path);
  });
});

describe('presenter console', () => {
  it('serves one self-contained HTML page at / with the four sections', async () => {
    const { app } = setup();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('<title>Great Eagle systems (simulated)</title>');
    for (const label of ['Trust service', 'Organizations', 'Account master', 'Cleanup job', 'Run cleanup now']) expect(res.text).toContain(label);
    expect(res.text).not.toMatch(/<script[^>]*\ssrc=/i);
    // The only resource from elsewhere is the portal's own web fonts; the page falls back to system fonts without them.
    expect(res.text.replace(/https:\/\/fonts\.(googleapis|gstatic)\.com[^"']*/g, '')).not.toMatch(/https?:\/\//);
  });

  it('has an inline script that parses', async () => {
    const { app } = setup();
    const scripts = [...(await request(app).get('/')).text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts).toHaveLength(1);
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });
});

describe('one way to refuse a request', () => {
  // The trust service, S5's registry and S8's legacy app are one service: a body none of them can use is refused in the same
  // words by the one error handler.
  it('answers a body that is not an object, and an unknown field, the same way in every router', async () => {
    const { app } = setup();
    const send = (method: 'post' | 'put', path: string, body: object) => request(app)[method](path).send(body);
    const routes: Array<['post' | 'put', string, object]> = [
      ['post', '/api/trust/orgs', { key: 'x', name: 'X' }],
      ['post', '/api/integrations', { key: 'abc', name: 'X', owner: 'pippin', customer: 'shire-freight' }],
      ['put', '/api/legacy/mode', { mode: 'both' }],
    ];
    for (const [method, path, good] of routes) {
      const notAnObject = await send(method, path, [1]);
      expect(notAnObject.status, path).toBe(400);
      expect(notAnObject.body, path).toEqual({ error: 'Expected a JSON object body' });
      const extraField = await send(method, path, { ...good, extra: 1 });
      expect(extraField.status, path).toBe(400);
      expect(extraField.body, path).toEqual({ error: 'Unknown field: extra' });
    }
  });
});

describe('service routes', () => {
  it('answers GET /healthz with 200', async () => {
    const { app } = setup();
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  it('answers an unknown /api route with a JSON 404', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('answers a malformed JSON body with a JSON 400', async () => {
    const { app } = setup();
    const res = await request(app).post('/api/requests').set('content-type', 'application/json').send('{"type":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
  });
});
