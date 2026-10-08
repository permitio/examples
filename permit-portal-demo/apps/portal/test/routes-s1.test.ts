import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness, unconfirmed } from './fakes';

const as = (app: Express, persona: string) => ({
  get: (path: string) => request(app).get(path).set('x-demo-persona', persona),
  post: (path: string, body: object = {}) => request(app).post(path).set('x-demo-persona', persona).send(body),
});

type H = ReturnType<typeof harness>;
const NW = 'riders-of-rohan';
const ORG = `organization:${NW}`;

/** Logs every PDP decision into the same list as Permit writes, so a test can assert their order. */
function logChecks(h: H, decide: (user: string, action: string) => boolean = () => true) {
  h.pdp.rule = (user, action, r) => {
    h.permit.log.push(['check', user, action, `${r.type}:${r.key}`]);
    return decide(user, action);
  };
}

/** Riders of Rohan after S1 step 1, with whichever tenant roles the test needs. */
function rohan(h: H, roles: Array<[user: string, role: string]>) {
  h.permit.tenants.set(NW, { key: NW, name: 'Riders of Rohan' });
  h.permit.instances.set(ORG, { key: NW, resource: 'organization', tenant: NW, attributes: { id: NW, ownership_verified: true } });
  for (const [user, role] of roles) h.permit.roles.push({ user, role, tenant: NW });
  h.mock.orgs.set(NW, { key: NW, name: 'Riders of Rohan', ownership_verified: true });
}

describe('POST /api/s1/organizations', () => {
  it('creates the tenant, the organization and the pending membership, in order, then files the first-admin request', async () => {
    const h = harness();
    h.permit.attributes.set('eowyn', {});
    const res = await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(res.status).toBe(201);
    expect(h.permit.log).toEqual([
      ['users.update', 'eowyn', { identity_verified: false, duplicate_check: 'clear', risk_state: 'ok' }],
      ['tenants.create', { key: NW, name: 'Riders of Rohan' }],
      ['resourceInstances.create', { key: NW, resource: 'organization', tenant: NW, attributes: { id: NW, ownership_verified: false } }],
      ['assignRole', 'pending_member', 'eowyn', NW],
    ]);
    expect(res.body.org).toEqual({ key: NW, name: 'Riders of Rohan', ownership_verified: false });
    expect(res.body.request).toMatchObject({ type: 'first_admin', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eowyn', initiated_by: 'eowyn', org_name: 'Riders of Rohan', status: 'pending' });
    expect(await h.mock.listRequests({ tenant: NW, type: 'first_admin' })).toHaveLength(1);
    expect(h.events.since(0).filter((e) => e.kind === 'write').map((e) => e.kind === 'write' && e.ok)).toEqual([true, true, true, true]);

    const again = await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Riders of Rohan already exists' });
    expect(h.permit.log).toHaveLength(4);
  });

  it("keeps the attributes Éowyn already has when it merges Éowyn's trust facts", async () => {
    const h = harness();
    h.permit.attributes.set('eowyn', { time_based_grants: [] });
    h.mock.facts.set('eowyn', { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
    await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(h.permit.attributes.get('eowyn')).toEqual({ time_based_grants: [], identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
  });

  it('rejects a blank name', async () => {
    const h = harness();
    expect((await as(h.app, 'eowyn').post('/api/s1/organizations', { name: '  ' })).status).toBe(400);
    expect((await as(h.app, 'eowyn').post('/api/s1/organizations', { name: '!!!' })).status).toBe(400);
  });
});

describe('the first-admin review', () => {
  it('approving assigns org_admin before it removes pending_member, then approves the request', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'pending_member']]);
    const first = h.mock.add({ type: 'first_admin', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eowyn', initiated_by: 'eowyn', org_name: 'Riders of Rohan' });
    logChecks(h);
    const res = await as(h.app, 'gandalf').post(`/api/requests/${first.id}/approve`);
    expect(res.status).toBe(200);
    expect(h.permit.log).toEqual([
      ['check', 'gandalf', 'review', 'onboarding_queue:first-admin'],
      ['assignRole', 'org_admin', 'eowyn', NW],
      ['unassignRole', 'pending_member', 'eowyn', NW],
    ]);
    expect(res.body.request).toMatchObject({ status: 'approved', reviewer: 'gandalf' });
    expect(res.body.ms).toEqual(expect.any(Number));
  });

  it("denying removes the requester's pending membership and records the comment", async () => {
    const h = harness();
    const res = await as(h.app, 'gandalf').post('/api/requests/req-grima-first-admin/deny', { comment: 'duplicate of an existing registration' });
    expect(res.status).toBe(200);
    expect(h.permit.log).toEqual([['unassignRole', 'pending_member', 'grima', 'riders-of-rohan-llc']]);
    expect(res.body.request).toMatchObject({ status: 'denied', reviewer: 'gandalf', reviewer_comment: 'duplicate of an existing registration' });
  });

  it('refuses a persona Permit does not allow to review, and writes nothing', async () => {
    const h = harness();
    h.pdp.rule = (user, action) => !(action === 'review' && user !== 'gandalf');
    const res = await as(h.app, 'eowyn').post('/api/requests/req-grima-first-admin/approve');
    expect(res.status).toBe(403);
    expect(res.body.decision).toBe('deny');
    expect(h.permit.log).toEqual([]);
    expect(h.mock.byId('req-grima-first-admin').status).toBe('pending');
  });
});

describe('GET /api/s1/reviewer-queue', () => {
  it("lists the pending first-admin requests with the requester's facts and the org's ownership fact", async () => {
    const h = harness();
    rohan(h, [['eowyn', 'pending_member']]);
    const first = h.mock.add({ type: 'first_admin', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eowyn', initiated_by: 'eowyn', org_name: 'Riders of Rohan' });
    const res = await as(h.app, 'gandalf').get('/api/s1/reviewer-queue');
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([
      { request: expect.objectContaining({ id: first.id }), facts: { identity_verified: false, duplicate_check: 'clear', risk_state: 'ok' }, ownership_verified: true },
      { request: expect.objectContaining({ id: 'req-grima-first-admin' }), facts: { identity_verified: false, duplicate_check: 'suspected', risk_state: 'ok' }, ownership_verified: false },
    ]);
    expect(h.pdp.asked).toEqual([{ user: 'gandalf', action: 'review', resource: 'onboarding_queue:first-admin' }]);
  });

  it('is refused to a persona Permit does not allow to review', async () => {
    const h = harness();
    h.pdp.deny('review');
    expect((await as(h.app, 'eowyn').get('/api/s1/reviewer-queue')).status).toBe(403);
  });
});

describe('the admin handover', () => {
  function handover(h: H) {
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    return h.mock.add({ type: 'admin_transfer', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eomer', initiated_by: 'eowyn', reason: 'parental leave' });
  }

  it('moves the admin role only after the new admin is effective', async () => {
    const h = harness();
    const transfer = handover(h);
    logChecks(h);
    const res = await as(h.app, 'eomer').post(`/api/requests/${transfer.id}/approve`);
    expect(res.status).toBe(200);
    expect(h.permit.log).toEqual([
      ['assignRole', 'org_admin', 'eomer', NW],
      ['check', 'eomer', 'manage_members', ORG],
      ['unassignRole', 'org_admin', 'eowyn', NW],
      ['assignRole', 'org_member', 'eowyn', NW],
    ]);
    expect(res.body.request).toMatchObject({ status: 'approved', reviewer: 'eomer' });
  });

  it('rolls back when the new admin is not effective, and the old admin keeps the role', async () => {
    const h = harness();
    const transfer = handover(h);
    logChecks(h, (user, action) => !(user === 'eomer' && action === 'manage_members'));
    const res = await as(h.app, 'eomer').post(`/api/requests/${transfer.id}/approve`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Éomer is not an effective admin yet: the trust facts are not all satisfied.' });
    expect(h.permit.log).toEqual([
      ['assignRole', 'org_admin', 'eomer', NW],
      ['check', 'eomer', 'manage_members', ORG],
      ['unassignRole', 'org_admin', 'eomer', NW],
    ]);
    expect(h.permit.holds('eowyn', 'org_admin', NW)).toBe(true);
    expect(h.permit.holds('eomer', 'org_admin', NW)).toBe(false);
    expect(h.mock.byId(transfer.id).status).toBe('pending');
  });

  it('may be accepted only by the nominee', async () => {
    const h = harness();
    const transfer = handover(h);
    const res = await as(h.app, 'sam').post(`/api/requests/${transfer.id}/approve`);
    expect(res.status).toBe(403);
    expect(h.permit.log).toEqual([]);
  });

  it('is filed by an admin Permit allows to transfer_admin', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    const res = await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/admin-transfers`, { to: 'eomer', reason: 'parental leave' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'admin_transfer', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eomer', initiated_by: 'eowyn', reason: 'parental leave', org_name: 'Riders of Rohan' });
    h.pdp.deny('transfer_admin');
    expect((await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/admin-transfers`, { to: 'eomer', reason: 'x' })).status).toBe(403);
  });
});

describe('member invitations', () => {
  it('are filed by an admin Permit allows to invite, and accepted only by the invitee, who becomes a member', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    h.pdp.rule = (user, action) => action !== 'review' || user === 'gandalf';
    const filed = await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/invitations`, { user: 'eomer' });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ type: 'member_invite', tenant: NW, target: ORG, role: 'org_member', requested_for: 'eomer', initiated_by: 'eowyn', status: 'pending' });
    expect((await as(h.app, 'eowyn').post(`/api/requests/${filed.body.id}/approve`)).status).toBe(403);
    const accepted = await as(h.app, 'eomer').post(`/api/requests/${filed.body.id}/approve`);
    expect(accepted.status).toBe(200);
    expect(h.permit.log).toEqual([['assignRole', 'org_member', 'eomer', NW]]);
    expect(accepted.body.request.status).toBe('approved');
    const eomer = await as(h.app, 'eomer').get('/api/approvals');
    expect(eomer.body.requests).toEqual([]);
  });

  it('shows the nominee their pending invitation and handover', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    h.pdp.rule = (user, action) => action !== 'review' || user === 'gandalf';
    const transfer = h.mock.add({ type: 'admin_transfer', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eomer', initiated_by: 'eowyn' });
    const res = await as(h.app, 'eomer').get('/api/approvals');
    expect(res.body.requests.map((r: { id: string }) => r.id)).toEqual([transfer.id]);
  });
});

describe('POST /api/s1/organizations/:key/step-down', () => {
  it('refuses to remove the last effective admin', async () => {
    const h = harness();
    rohan(h, [['eomer', 'org_admin'], ['eowyn', 'org_member']]);
    const res = await as(h.app, 'eomer').post(`/api/s1/organizations/${NW}/step-down`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Riders of Rohan must keep at least one effective admin.' });
    expect(h.permit.log).toEqual([]);
    expect(h.pdp.asked).toEqual([{ user: 'eomer', action: 'manage_members', resource: ORG }]);
  });

  it('refuses when the other admin holds the role but is not effective', async () => {
    const h = harness();
    rohan(h, [['eomer', 'org_admin'], ['eowyn', 'org_admin']]);
    h.pdp.rule = (user) => user !== 'eowyn';
    expect((await as(h.app, 'eomer').post(`/api/s1/organizations/${NW}/step-down`)).status).toBe(409);
  });

  it('lets an admin step down while another effective admin remains', async () => {
    const h = harness();
    rohan(h, [['eomer', 'org_admin'], ['eowyn', 'org_admin']]);
    const res = await as(h.app, 'eomer').post(`/api/s1/organizations/${NW}/step-down`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.permit.log).toEqual([['unassignRole', 'org_admin', 'eomer', NW], ['assignRole', 'org_member', 'eomer', NW]]);
  });

  it('is only for an admin of the organization', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    expect((await as(h.app, 'eomer').post(`/api/s1/organizations/${NW}/step-down`)).status).toBe(403);
  });
});

describe('POST /api/s1/organizations/:key/ean-associations', () => {
  it("answers 422 with the account master's reason for a wrong proof, and creates nothing", async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    const res = await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/ean-associations`, { ean: 'EAN-2001', proof: 'INV-0000' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'The proof does not match the account master' });
    expect(h.permit.log).toEqual([]);
  });

  it('creates the EAN with association_verified when the account master accepts the proof', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    const res = await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/ean-associations`, { ean: 'EAN-2001', proof: 'INV-2001-0815' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ean: 'EAN-2001', ms: expect.any(Number) });
    expect(h.permit.log).toEqual([['resourceInstances.create', { key: 'EAN-2001', resource: 'ean', tenant: NW, attributes: { id: 'EAN-2001', association_verified: true } }]]);
  });

  it('asks Permit first and refuses when request_ean_association is denied', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    h.pdp.deny('request_ean_association');
    const res = await as(h.app, 'eowyn').post(`/api/s1/organizations/${NW}/ean-associations`, { ean: 'EAN-2001', proof: 'INV-2001-0815' });
    expect(res.status).toBe(403);
    expect(h.mock.requests.some((r) => r.type === 'ean_association')).toBe(false);
  });
});

describe('GET /api/s1/organizations/:key', () => {
  it('answers 404 Organization not found when the tenant does not exist', async () => {
    const h = harness();
    const res = await as(h.app, 'eowyn').get(`/api/s1/organizations/${NW}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Organization not found' });
  });

  it('describes the organization as the persona sees it', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member'], ['eomer', 'org_admin']]);
    h.permit.instances.set('ean:EAN-2001', { key: 'EAN-2001', resource: 'ean', tenant: NW, attributes: { id: 'EAN-2001', association_verified: true } });
    h.permit.instances.set('ean:EAN-2002', { key: 'EAN-2002', resource: 'ean', tenant: NW, attributes: { id: 'EAN-2002', association_verified: false } });
    const first = h.mock.add({ type: 'first_admin', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eowyn', initiated_by: 'eowyn', status: 'approved' });
    h.pdp.rule = (_user, action, r) => !['invite', 'transfer_admin'].includes(action) && r.key !== 'EAN-2002';
    const res = await as(h.app, 'eowyn').get(`/api/s1/organizations/${NW}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      org: { key: NW, name: 'Riders of Rohan', ownership_verified: true },
      can: { view_own_request: true, view_profile: true, manage_members: true, invite: false, transfer_admin: false, request_ean_association: true },
      facts: { user: { identity_verified: false, duplicate_check: 'clear', risk_state: 'ok' }, ownership_verified: true },
      members: [{ user: 'eowyn', roles: ['org_admin'] }, { user: 'eomer', roles: ['org_member', 'org_admin'] }],
      eans: [{ key: 'EAN-2001', visible: true }, { key: 'EAN-2002', visible: false }],
      requests: [expect.objectContaining({ id: first.id })],
    });
  });

  it('answers null facts for a persona Great Eagle holds none for', async () => {
    const h = harness();
    rohan(h, []);
    const res = await as(h.app, 'gandalf').get(`/api/s1/organizations/${NW}`);
    expect(res.body.facts).toEqual({ user: null, ownership_verified: true });
  });

  it("tags every check of a background refresh as refresh, the EAN filter's too", async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    h.permit.instances.set('ean:EAN-2001', { key: 'EAN-2001', resource: 'ean', tenant: NW, attributes: { id: 'EAN-2001', association_verified: true } });
    await request(h.app).get(`/api/s1/organizations/${NW}`).set('x-demo-persona', 'eowyn').set('x-demo-source', 'refresh');
    expect(sources(h)).toEqual(Array(7).fill('refresh'));
  });
});

/** The source of every check event, oldest first. */
function sources(h: H): string[] {
  return h.events.since(0).flatMap((e) => (e.kind === 'check' ? [e.source] : []));
}

describe('guard checks', () => {
  it('tags the last-admin guard as guard, even inside an action', async () => {
    const h = harness();
    rohan(h, [['eomer', 'org_admin'], ['eowyn', 'org_admin']]);
    await as(h.app, 'eomer').post(`/api/s1/organizations/${NW}/step-down`);
    expect(sources(h)).toEqual(['guard', 'guard']);
    expect(h.events.since(0).flatMap((e) => (e.kind === 'check' ? [e.label] : []))).toEqual(['last-admin guard', 'last-admin guard']);
  });

  it("tags the handover's effectiveness check as guard and the reviewer's own check as action", async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    const transfer = h.mock.add({ type: 'admin_transfer', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eomer', initiated_by: 'eowyn' });
    await as(h.app, 'eomer').post(`/api/requests/${transfer.id}/approve`);
    await as(h.app, 'gandalf').post('/api/requests/req-grima-first-admin/deny', { comment: 'duplicate' });
    expect(h.events.since(0).flatMap((e) => (e.kind === 'check' ? [[e.user, e.action, e.source]] : []))).toEqual([
      ['eomer', 'manage_members', 'guard'],
      ['gandalf', 'review', 'action'],
    ]);
  });
});

/** The decision panel's write rows, as `[what, ok]`. */
function writes(h: H): Array<[string, boolean]> {
  return h.events.since(0).flatMap((e): Array<[string, boolean]> => (e.kind === 'write' ? [[e.what, e.ok]] : []));
}

const PDP_TIMEOUT = 'The PDP did not confirm this change within 5 seconds.';

describe('retrying a flow after an unconfirmed write', () => {
  it('create organization: a 424 on step 2 leaves no request, and the retry finishes the creation', async () => {
    const h = harness();
    h.permit.landedThen.set('resourceInstances.create', unconfirmed());
    const first = await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(first.status).toBe(424);
    expect(first.body).toEqual({ error: PDP_TIMEOUT });
    expect(await h.mock.listRequests({ tenant: NW })).toEqual([]);

    const retry = await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(retry.status).toBe(201);
    expect(retry.body.request).toMatchObject({ type: 'first_admin', tenant: NW, requested_for: 'eowyn', status: 'pending' });
    expect(h.permit.holds('eowyn', 'pending_member', NW)).toBe(true);
    expect(h.permit.log.filter(([op]) => op !== 'users.update').map(([op]) => op)).toEqual(['tenants.create', 'resourceInstances.create', 'assignRole']);
    expect(writes(h).slice(-3)).toEqual([
      [`create tenant ${NW} (already done)`, true],
      [`create ${ORG} (already done)`, true],
      [`assign pending_member to eowyn in ${NW}`, true],
    ]);

    const again = await as(h.app, 'eowyn').post('/api/s1/organizations', { name: 'Riders of Rohan' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Riders of Rohan already exists' });
    expect(await h.mock.listRequests({ tenant: NW, type: 'first_admin' })).toHaveLength(1);
  });

  it("create organization: never resumes someone else's organization", async () => {
    const h = harness();
    for (const name of ['Shire Freight', 'Riders of Rohan LLC']) {
      const res = await as(h.app, 'eowyn').post('/api/s1/organizations', { name });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: `${name} already exists` });
    }
    expect(h.permit.log).toEqual([]);
  });

  it('first-admin approval: a 424 on step 2 leaves the request pending, and the retry approves it', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'pending_member']]);
    const request1 = h.mock.add({ type: 'first_admin', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eowyn', initiated_by: 'eowyn' });
    h.permit.landedThen.set('unassignRole', unconfirmed());
    const first = await as(h.app, 'gandalf').post(`/api/requests/${request1.id}/approve`);
    expect(first.status).toBe(424);
    expect(h.mock.byId(request1.id).status).toBe('pending');

    const retry = await as(h.app, 'gandalf').post(`/api/requests/${request1.id}/approve`);
    expect(retry.status).toBe(200);
    expect(retry.body.request).toMatchObject({ status: 'approved', reviewer: 'gandalf' });
    expect(h.permit.holds('eowyn', 'org_admin', NW)).toBe(true);
    expect(h.permit.holds('eowyn', 'pending_member', NW)).toBe(false);
    expect(writes(h).slice(-2)).toEqual([
      [`assign org_admin to eowyn in ${NW} (already done)`, true],
      [`unassign pending_member from eowyn in ${NW} (already done)`, true],
    ]);
  });

  it('member invitation: a 424 on the role write leaves it pending, and the retry accepts it', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin']]);
    h.pdp.rule = (user, action) => action !== 'review' || user === 'gandalf';
    const invite = h.mock.add({ type: 'member_invite', tenant: NW, target: ORG, role: 'org_member', requested_for: 'eomer', initiated_by: 'eowyn' });
    h.permit.landedThen.set('assignRole', unconfirmed());
    expect((await as(h.app, 'eomer').post(`/api/requests/${invite.id}/approve`)).status).toBe(424);
    expect(h.mock.byId(invite.id).status).toBe('pending');

    const retry = await as(h.app, 'eomer').post(`/api/requests/${invite.id}/approve`);
    expect(retry.status).toBe(200);
    expect(retry.body.request.status).toBe('approved');
    expect(writes(h).at(-1)).toEqual([`assign org_member to eomer in ${NW} (already done)`, true]);
  });

  it('admin handover: a 424 on step 2 leaves it pending, and the retry completes the handover', async () => {
    const h = harness();
    rohan(h, [['eowyn', 'org_admin'], ['eomer', 'org_member']]);
    const transfer = h.mock.add({ type: 'admin_transfer', tenant: NW, target: ORG, role: 'org_admin', requested_for: 'eomer', initiated_by: 'eowyn' });
    h.permit.landedThen.set('unassignRole', unconfirmed());
    expect((await as(h.app, 'eomer').post(`/api/requests/${transfer.id}/approve`)).status).toBe(424);
    expect(h.mock.byId(transfer.id).status).toBe('pending');

    const retry = await as(h.app, 'eomer').post(`/api/requests/${transfer.id}/approve`);
    expect(retry.status).toBe(200);
    expect(retry.body.request.status).toBe('approved');
    expect(h.permit.holds('eomer', 'org_admin', NW)).toBe(true);
    expect(h.permit.holds('eowyn', 'org_admin', NW)).toBe(false);
    expect(h.permit.holds('eowyn', 'org_member', NW)).toBe(true);
    expect(writes(h).slice(-3)).toEqual([
      [`assign org_admin to eomer in ${NW} (already done)`, true],
      [`unassign org_admin from eowyn in ${NW} (already done)`, true],
      [`assign org_member to eowyn in ${NW}`, true],
    ]);
  });
});
