import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { grant, harness, NOW } from '#test/fakes';

const NW = 'riders-of-rohan';

describe('POST /internal/facts-changed', () => {
  it("merges the user's new trust facts and keeps their grant entries", async () => {
    const h = harness();
    h.permit.attributes.set('eowyn', { identity_verified: false, duplicate_check: 'clear', risk_state: 'ok', time_based_grants: [grant('SHP-77001', NOW + 5)] });
    h.mock.facts.set('eowyn', { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
    const res = await request(h.app).post('/internal/facts-changed').send({ subject: 'user', key: 'eowyn' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(h.permit.attributes.get('eowyn')).toEqual({ identity_verified: true, duplicate_check: 'clear', risk_state: 'ok', time_based_grants: [grant('SHP-77001', NOW + 5)] });
    expect(h.events.since(0)).toEqual([expect.objectContaining({ kind: 'write', what: 'trust facts from Great Eagle (eowyn)', ok: true })]);
  });

  it('answers an error, never a success, when the PDP does not confirm the write (the mock waits on this answer)', async () => {
    const h = harness();
    h.mock.facts.set('eowyn', { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
    h.permit.failures.userUpdate = Object.assign(new Error('Request failed with status code 424'), { status: 424 });
    const res = await request(h.app).post('/internal/facts-changed').send({ subject: 'user', key: 'eowyn' });
    expect(res.status).toBe(424);
    expect(res.body).toEqual({ error: 'The PDP did not confirm this change within 5 seconds.' });
  });

  it('skips the write when nothing changed or Great Eagle holds no facts for the user', async () => {
    const h = harness();
    expect((await request(h.app).post('/internal/facts-changed').send({ subject: 'user', key: 'eowyn' })).body).toEqual({ skipped: true });
    expect((await request(h.app).post('/internal/facts-changed').send({ subject: 'user', key: 'gandalf' })).body).toEqual({ skipped: true });
    expect(h.permit.log).toEqual([]);
  });

  it("skips an organization's fact while its tenant does not exist in Permit", async () => {
    const h = harness();
    h.mock.orgs.set(NW, { key: NW, name: 'Riders of Rohan', ownership_verified: true });
    const res = await request(h.app).post('/internal/facts-changed').send({ subject: 'org', key: NW });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipped: true });
    expect(h.permit.log).toEqual([]);
  });

  it("sets the organization's ownership fact on its Permit instance", async () => {
    const h = harness();
    h.permit.tenants.set(NW, { key: NW, name: 'Riders of Rohan' });
    h.permit.instances.set(`organization:${NW}`, { key: NW, resource: 'organization', tenant: NW, attributes: { id: NW, ownership_verified: false } });
    h.mock.orgs.set(NW, { key: NW, name: 'Riders of Rohan', ownership_verified: true });
    const res = await request(h.app).post('/internal/facts-changed').send({ subject: 'org', key: NW });
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(h.permit.log).toEqual([['resourceInstances.update', `organization:${NW}`, { id: NW, ownership_verified: true }]]);
  });

  it('rejects an unknown subject or user', async () => {
    const h = harness();
    expect((await request(h.app).post('/internal/facts-changed').send({ subject: 'device', key: 'eowyn' })).status).toBe(400);
    expect((await request(h.app).post('/internal/facts-changed').send({ subject: 'user', key: 'mallory' })).status).toBe(400);
    expect((await request(h.app).post('/internal/facts-changed').send({ subject: 'user' })).status).toBe(400);
  });
});

describe('POST /internal/cleanup-expired', () => {
  it('removes only expired grant entries, expires their requests and tells whoever invited', async () => {
    const h = harness();
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW - 1), grant('SHP-77002', NOW + 60_000)] });
    const expiredInvite = h.mock.add({ type: 'collaborator_invite', tenant: 'shire-freight', target: 'shipment:SHP-77001', role: 'collaborator', requested_for: 'aragorn', initiated_by: 'frodo', duration_ms: 120_000, status: 'approved' });
    const liveInvite = h.mock.add({ type: 'collaborator_invite', tenant: 'shire-freight', target: 'shipment:SHP-77002', role: 'collaborator', requested_for: 'aragorn', initiated_by: 'frodo', duration_ms: 120_000, status: 'approved' });
    const res = await request(h.app).post('/internal/cleanup-expired');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 1 });
    expect(h.permit.attributes.get('aragorn')).toEqual({ time_based_grants: [grant('SHP-77002', NOW + 60_000)] });
    expect(h.mock.byId(expiredInvite.id)).toMatchObject({ status: 'expired' });
    expect(h.mock.byId(expiredInvite.id).history.at(-1)).toMatchObject({ status: 'expired', by: 'cleanup-job' });
    expect(h.mock.byId(liveInvite.id).status).toBe('approved');
    expect(h.mock.notes).toEqual([{ user: 'frodo', text: expect.stringContaining('SHP-77001') }]);
  });

  it('writes nothing when no grant has expired', async () => {
    const h = harness();
    h.permit.attributes.set('aragorn', { time_based_grants: [grant('SHP-77001', NOW)] });
    h.mock.add({ type: 'collaborator_invite', tenant: 'shire-freight', target: 'shipment:SHP-77001', role: 'collaborator', requested_for: 'aragorn', initiated_by: 'frodo', duration_ms: 120_000, status: 'approved' });
    const res = await request(h.app).post('/internal/cleanup-expired');
    expect(res.body).toEqual({ removed: 0 });
    expect(h.permit.log).toEqual([]);
    expect(h.mock.notes).toEqual([]);
  });
});
