import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CheckEvent } from '#src/server/events';
import { DAY, grant, harness, NOW } from '#test/fakes';

const as = (app: Express, persona: string) => ({
  get: (path: string) => request(app).get(path).set('x-demo-persona', persona),
  post: (path: string, body: object = {}) => request(app).post(path).set('x-demo-persona', persona).send(body),
});

type H = ReturnType<typeof harness>;
const SHP = 'shipment:SHP-77001';

/** Frodo's invitation of Aragorn to SHP-77001, as the mock stores it: no duration, the approver sets it. */
function inviteFields() {
  return { type: 'collaborator_invite' as const, tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'frodo', reason: 'customs clearance' };
}

function pendingInvite(h: H) {
  return h.mock.add(inviteFields());
}

function checks(h: H): CheckEvent[] {
  return h.events.since(0).filter((e): e is CheckEvent => e.kind === 'check');
}

describe('POST /api/s4/shipments/:key/invitations', () => {
  it('refuses with 403 when Permit denies invite_collaborator, and records nothing', async () => {
    const h = harness();
    h.pdp.deny('invite_collaborator');
    const before = h.mock.requests.length;
    const res = await as(h.app, 'frodo').post('/api/s4/shipments/SHP-77001/invitations', { user: 'aragorn', reason: 'customs clearance' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), decision: 'deny' });
    expect(h.mock.requests).toHaveLength(before);
  });

  it('files a pending collaborator invitation when Permit allows it', async () => {
    const h = harness();
    const res = await as(h.app, 'frodo').post('/api/s4/shipments/SHP-77001/invitations', { user: 'aragorn', reason: 'customs clearance' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: 'collaborator_invite', tenant: 'shire-freight', target: SHP, role: 'collaborator',
      initiated_by: 'frodo', requested_for: 'aragorn', reason: 'customs clearance', status: 'pending',
    });
    // The inviter sets no duration: the approver does.
    expect(res.body.duration_ms).toBeUndefined();
    expect(h.pdp.asked).toEqual([{ user: 'frodo', action: 'invite_collaborator', resource: SHP }]);
  });

  it('rejects an unknown user and an unknown shipment', async () => {
    const h = harness();
    expect((await as(h.app, 'frodo').post('/api/s4/shipments/SHP-77001/invitations', { user: 'mallory' })).status).toBe(400);
    expect((await as(h.app, 'frodo').post('/api/s4/shipments/SHP-00000/invitations', { user: 'aragorn' })).status).toBe(404);
  });
});

describe('approving a collaborator invitation', () => {
  it('refuses self-approval with 409 and writes nothing', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    const res = await as(h.app, 'frodo').post(`/api/requests/${invite.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A request cannot be approved by the person who made it or the person it is for.' });
    expect(h.permit.log).toEqual([]);
    expect(h.mock.byId(invite.id).status).toBe('pending');
  });

  it("writes the grant for the duration the approver set, and records that duration on the request", async () => {
    const h = harness();
    const invite = pendingInvite(h);
    const res = await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`, { comment: 'ok', durationMs: 120_000 });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: invite.id, status: 'approved', reviewer: 'sam', reviewer_comment: 'ok', duration_ms: 120_000 });
    expect(res.body.ms).toEqual(expect.any(Number));
    expect(h.permit.attributes.get('aragorn')).toEqual({ time_based_grants: [grant('SHP-77001', NOW + 120_000)] });
    expect(h.pdp.asked).toEqual([{ user: 'sam', action: 'approve_collaborator', resource: SHP }]);
    expect(h.events.since(0)).toContainEqual(expect.objectContaining({ kind: 'write', what: 'grant SHP-77001 (aragorn)', ok: true }));
  });

  it('approve returns 424 and leaves the request pending when the write is not confirmed', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    h.permit.failures.userUpdate = Object.assign(new Error('Request failed with status code 424'), { status: 424 });
    const res = await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`, { durationMs: 120_000 });
    expect(res.status).toBe(424);
    expect(res.body).toEqual({ error: 'The PDP did not confirm this change within 5 seconds.' });
    expect(h.mock.byId(invite.id).status).toBe('pending');
    expect(h.events.since(0)).toContainEqual(expect.objectContaining({ kind: 'write', ok: false, error: 'The PDP did not confirm this change within 5 seconds.' }));
  });

  it('refuses with 403 when Permit denies approve_collaborator, and writes nothing', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    h.pdp.deny('approve_collaborator');
    const res = await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`);
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('deny');
    expect(h.permit.log).toEqual([]);
    expect(h.mock.byId(invite.id).status).toBe('pending');
  });

  it('refuses an approval without a duration, or with one out of bounds, before writing anything', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    const missing = await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`);
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'Choose how long the access lasts.' });
    for (const durationMs of [1_000, 31 * DAY, 0, 'two minutes']) {
      expect((await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`, { durationMs })).status).toBe(400);
    }
    expect(h.permit.log).toEqual([]);
    expect(h.mock.byId(invite.id).status).toBe('pending');
  });

  it('refuses a request that is no longer pending before writing anything', async () => {
    const h = harness();
    const invite = h.mock.add({ ...inviteFields(), status: 'approved' });
    const res = await as(h.app, 'sam').post(`/api/requests/${invite.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Cannot move a approved request to approved' });
    expect(h.permit.log).toEqual([]);
  });

  it('answers 404 for an unknown request', async () => {
    const h = harness();
    expect((await as(h.app, 'sam').post('/api/requests/req-nope/approve')).status).toBe(404);
  });

  it('denies with a comment, after the same permission check', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    expect((await as(h.app, 'frodo').post(`/api/requests/${invite.id}/deny`, { comment: 'mine' })).status).toBe(409);
    const res = await as(h.app, 'sam').post(`/api/requests/${invite.id}/deny`, { comment: 'not needed' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'denied', reviewer: 'sam', reviewer_comment: 'not needed' });
    expect(h.pdp.asked).toEqual([{ user: 'sam', action: 'approve_collaborator', resource: SHP }]);
    expect(h.permit.log).toEqual([]);
  });
});

describe('renewals', () => {
  it('refuses with 403 "Renewal not allowed by policy" when Permit denies request_renewal', async () => {
    const h = harness();
    h.pdp.deny('request_renewal');
    const before = h.mock.requests.length;
    const res = await as(h.app, 'aragorn').post('/api/s4/shipments/SHP-77001/renewals', { days: 7 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Renewal not allowed by policy', decision: 'deny' });
    expect(h.mock.requests).toHaveLength(before);
    expect(checks(h)[0]?.input).toMatchObject({ action: 'request_renewal', resource: { attributes: { requested_days: 7, id: 'SHP-77001' } } });
  });

  it('files a pending renewal for the requester', async () => {
    const h = harness();
    const res = await as(h.app, 'aragorn').post('/api/s4/shipments/SHP-77001/renewals', { days: 45 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 45, status: 'pending' });
  });

  it.each([
    ['an expired grant extends from now', NOW - 5_000, 0, NOW + 7 * DAY, 1],
    ['a live grant extends from its expiry', NOW + 5_000, 1, NOW + 5_000 + 7 * DAY, 2],
  ])('approving %s and counts the renewal', async (_name, expires, used, newExpires, newUsed) => {
    const h = harness();
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', expires, used), grant('SHP-77002', 42)] });
    const renewal = h.mock.add({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 7 });
    const res = await as(h.app, 'frodo').post(`/api/requests/${renewal.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'approved', reviewer: 'frodo' });
    expect(h.permit.attributes.get('aragorn')).toEqual({ time_based_grants: [grant('SHP-77002', 42), grant('SHP-77001', newExpires, newUsed)] });
    expect(h.pdp.asked).toEqual([{ user: 'frodo', action: 'approve_renewal', resource: SHP }]);
  });

  it('refuses to approve a renewal when the grant is gone, and leaves it pending', async () => {
    const h = harness();
    const renewal = h.mock.add({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 7 });
    const res = await as(h.app, 'frodo').post(`/api/requests/${renewal.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Aragorn has no grant on SHP-77001 to renew.' });
    expect(h.mock.byId(renewal.id).status).toBe('pending');
  });
});

describe('POST /api/s4/shipments/:key/revoke', () => {
  it("removes only that shipment's grant and marks its approved requests revoked", async () => {
    const h = harness();
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW + 9_000, 1), grant('SHP-77002', NOW + 9_000)] });
    const invite = h.mock.add({ ...inviteFields(), status: 'approved' });
    const renewal = h.mock.add({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 7, status: 'approved' });
    const other = h.mock.add({ ...inviteFields(), target: 'shipment:SHP-77002', status: 'approved' });
    const res = await as(h.app, 'frodo').post('/api/s4/shipments/SHP-77001/revoke', { user: 'aragorn' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(h.permit.attributes.get('aragorn')).toEqual({ time_based_grants: [grant('SHP-77002', NOW + 9_000)] });
    expect([invite, renewal, other].map((r) => h.mock.byId(r.id).status)).toEqual(['revoked', 'revoked', 'approved']);
    expect(h.mock.byId(invite.id).history.at(-1)).toMatchObject({ status: 'revoked', by: 'frodo' });
  });

  it('refuses with 403 when Permit denies revoke_collaborator', async () => {
    const h = harness();
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW + 9_000)] });
    h.pdp.deny('revoke_collaborator');
    expect((await as(h.app, 'aragorn').post('/api/s4/shipments/SHP-77001/revoke', { user: 'aragorn' })).status).toBe(403);
    expect(h.permit.attributes.get('aragorn')).toEqual({ time_based_grants: [grant('SHP-77001', NOW + 9_000)] });
  });
});

describe('documents', () => {
  it('adds a document when Permit allows upload_docs, and refuses otherwise', async () => {
    const h = harness();
    const res = await as(h.app, 'aragorn').post('/api/s4/shipments/SHP-77001/documents', { name: 'commercial-invoice.pdf' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'commercial-invoice.pdf', by: 'aragorn' });
    h.pdp.deny('upload_docs');
    expect((await as(h.app, 'aragorn').post('/api/s4/shipments/SHP-77001/documents', { name: 'x.pdf' })).status).toBe(403);
    expect(h.mock.documents.get('SHP-77001')).toHaveLength(1);
  });
});

describe('GET /api/s4/shipments', () => {
  it('lists only the shipments Permit lets the persona view, plus the requests shared with them', async () => {
    const h = harness();
    h.pdp.rule = (user, action, r) => user === 'aragorn' && action === 'view' && r.key === 'SHP-77001';
    const invite = pendingInvite(h);
    const renewal = h.mock.add({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 7 });
    h.mock.add({ type: 'member_invite', tenant: 'riders-of-rohan', target: 'organization:riders-of-rohan', role: 'org_member', requested_for: 'aragorn', initiated_by: 'eowyn' });
    const res = await as(h.app, 'aragorn').get('/api/s4/shipments');
    expect(res.status).toBe(200);
    expect(res.body.shipments).toEqual([h.seed.shipments[0]]);
    expect(res.body.shared.map((r: { id: string }) => r.id).sort()).toEqual([invite.id, renewal.id].sort());
    expect(checks(h).map((e) => [e.action, e.resource, e.allow, e.bulk])).toEqual([
      ['view', SHP, true, 2],
      ['view', 'shipment:SHP-77002', false, 2],
    ]);
  });
});

describe('GET /api/s4/shipments/:key', () => {
  it("answers what the persona can do, the collaborators' grants, the documents and the requests", async () => {
    const h = harness();
    h.pdp.rule = (_user, action) => ['view', 'upload_docs', 'request_renewal'].includes(action);
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW + 60_000, 1)] });
    const invite = h.mock.add({ ...inviteFields(), status: 'approved' });
    await h.mock.addDocument('SHP-77001', 'invoice.pdf', 'aragorn');
    const res = await as(h.app, 'aragorn').get('/api/s4/shipments/SHP-77001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      shipment: h.seed.shipments[0],
      can: { view: true, upload_docs: true, invite_collaborator: false, approve_collaborator: false, revoke_collaborator: false, request_renewal: true },
      collaborators: [{ user: 'aragorn', expires: NOW + 60_000, renewals_used: 1, active: true }],
      documents: [{ name: 'invoice.pdf', by: 'aragorn' }],
    });
    expect(res.body.requests.map((r: { id: string }) => r.id)).toEqual([invite.id]);
    const renewalCheck = checks(h).find((e) => e.action === 'request_renewal');
    expect(renewalCheck?.input).toMatchObject({ resource: { attributes: { requested_days: 7 } } });
    expect(new Set(checks(h).map((e) => e.bulk))).toEqual(new Set([6]));
  });

  it("tags a background refresh's checks as refresh, and a click's as action", async () => {
    const h = harness();
    await request(h.app).get('/api/s4/shipments/SHP-77001').set('x-demo-persona', 'aragorn').set('x-demo-source', 'refresh');
    expect(checks(h).map((e) => e.source)).toEqual(Array(6).fill('refresh'));
    await request(h.app).get('/api/s4/shipments').set('x-demo-persona', 'aragorn');
    expect(checks(h).slice(6).map((e) => e.source)).toEqual(['action', 'action']);
  });

  it('shows an expired grant as inactive and hides the documents when view is denied', async () => {
    const h = harness();
    h.pdp.rule = () => false;
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW - 1)] });
    h.mock.add({ ...inviteFields(), status: 'approved' });
    await h.mock.addDocument('SHP-77001', 'invoice.pdf', 'aragorn');
    const res = await as(h.app, 'aragorn').get('/api/s4/shipments/SHP-77001');
    expect(res.body.can.view).toBe(false);
    expect(res.body.collaborators).toEqual([{ user: 'aragorn', expires: NOW - 1, renewals_used: 0, active: false }]);
    expect(res.body.documents).toEqual([]);
  });

  it('answers 404 for an unknown shipment', async () => {
    const h = harness();
    expect((await as(h.app, 'aragorn').get('/api/s4/shipments/SHP-00000')).status).toBe(404);
  });
});

describe('GET /api/approvals', () => {
  it("lists the pending requests the persona may decide, never the persona's own", async () => {
    const h = harness();
    const invite = pendingInvite(h);
    const renewal = h.mock.add({ type: 'renewal', tenant: 'shire-freight', target: SHP, role: 'collaborator', requested_for: 'aragorn', initiated_by: 'aragorn', requested_days: 7 });
    // Nobody here may review Gríma's seeded first-admin request; Sam may not approve renewals.
    h.pdp.rule = (user, action) => action !== 'review' && !(user === 'sam' && action === 'approve_renewal');
    const sam = await as(h.app, 'sam').get('/api/approvals');
    expect(sam.body.requests.map((r: { id: string }) => r.id)).toEqual([invite.id]);
    const frodo = await as(h.app, 'frodo').get('/api/approvals');
    expect(frodo.body.requests.map((r: { id: string }) => r.id)).toEqual([renewal.id]);
    // Even with Permit allowing it, nobody is offered a decision on a request they made or that is for them.
    const aragorn = await as(h.app, 'aragorn').get('/api/approvals');
    expect(aragorn.body.requests).toEqual([]);
  });
});

describe('proxied mock reads', () => {
  it('lists requests by tenant and passes the cleanup status through', async () => {
    const h = harness();
    const invite = pendingInvite(h);
    const res = await as(h.app, 'frodo').get('/api/requests?tenant=shire-freight');
    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([invite.id]);
    const status = await as(h.app, 'frodo').get('/api/cleanup/status');
    expect(status.body).toEqual(await h.mock.cleanupStatus());
  });
});
