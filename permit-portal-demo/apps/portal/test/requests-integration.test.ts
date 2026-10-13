// The integration_access request in the approval workflow: Sam approves production scope for the connector,
// the four-eyes rule holds, and Permit decides who may approve. The PDP follows the policy (fakes-s5.ts).
import { describe, expect, it } from 'vitest';
import { as, askForProduction, asConnector, KEY, register, s5World, SHIRE, writesOf } from '#test/fakes-s5';
import { unconfirmed } from '#test/fakes';

const approve = (h: ReturnType<typeof s5World>, persona: string, id: string, body: object = {}) => as(h.app, persona).post(`/api/requests/${id}/approve`, body);

describe('approving an integration_access request', () => {
  it('approval assigns integration_client to the connector, not the initiator', async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    const writes = h.permit.log.length;
    const res = await approve(h, 'sam', filed.id, { comment: 'Production scope for the ERP' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: filed.id, status: 'approved', reviewer: 'sam', reviewer_comment: 'Production scope for the ERP' });
    // One write, for the connector's own identity. Pippin, who asked, gets nothing.
    expect(h.permit.log.slice(writes)).toEqual([['assignRole', 'integration_client', KEY, SHIRE, 'ean:EAN-1001']]);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(true);
    expect(h.permit.roles.filter((r) => r.user === 'pippin').map((r) => [r.role, r.resource_instance])).toEqual([['developer', undefined]]);
    // Sam was asked about the EAN the request names.
    expect(h.pdp.asked).toContainEqual({ user: 'sam', action: 'approve_integration', resource: 'ean:EAN-1001' });
    expect(writesOf(h).at(-1)).toEqual({ what: 'assign integration_client on ean:EAN-1001 to shire-erp', ok: true });
  });

  it("Pippin cannot approve Pippin's own request", async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    // Permit would allow it here, so the refusal can only be the portal's four-eyes rule.
    h.pdp.rule = () => true;
    const writes = h.permit.log.length;
    const res = await approve(h, 'pippin', filed.id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A request cannot be approved by the person who made it or the person it is for.' });
    expect(h.permit.log).toHaveLength(writes);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(false);
    expect((await h.mock.getRequest(filed.id))?.status).toBe('pending');
  });

  it('Permit decides who may approve: Frodo is denied approve_integration, and the request stays pending', async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    const writes = h.permit.log.length;
    const res = await approve(h, 'frodo', filed.id);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permit denied approve_integration on ean:EAN-1001.', decision: 'deny' });
    expect(h.permit.log).toHaveLength(writes);
    expect((await h.mock.getRequest(filed.id))?.status).toBe('pending');
  });

  it("lists the request for Sam, whom Permit lets approve it, and not for Frodo, who started nothing, or Pippin, who did", async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    expect((await as(h.app, 'sam').get('/api/approvals')).body).toEqual({ requests: [filed] });
    expect((await as(h.app, 'frodo').get('/api/approvals')).body).toEqual({ requests: [] });
    expect((await as(h.app, 'pippin').get('/api/approvals')).body).toEqual({ requests: [] });
  });

  it('denying records the decision and gives the connector nothing', async () => {
    const h = s5World();
    const secret = await register(h);
    const filed = await askForProduction(h);
    const writes = h.permit.log.length;
    const res = await as(h.app, 'sam').post(`/api/requests/${filed.id}/deny`, { comment: 'Not this quarter' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'denied', reviewer: 'sam', reviewer_comment: 'Not this quarter' });
    expect(h.permit.log).toHaveLength(writes);
    expect((await asConnector(h.app, secret).post('/api/integration/shipments', { ean: 'EAN-1001', title: 'x' })).status).toBe(403);
  });

  it('a write the PDP did not confirm leaves the request pending, and approving again completes it', async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    // The role lands at Permit, the PDP does not show it in time: 424.
    h.permit.landedThen.set('assignRole', unconfirmed());
    const first = await approve(h, 'sam', filed.id);
    expect(first.status).toBe(424);
    expect((await h.mock.getRequest(filed.id))?.status).toBe('pending');
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(true);

    // The retry writes the role again, which Permit takes as it takes any repeat, the PDP confirms it, and the approval finishes.
    const retry = await approve(h, 'sam', filed.id);
    expect(retry.status).toBe(200);
    expect(retry.body.request.status).toBe('approved');
    expect(writesOf(h).slice(-2)).toEqual([
      { what: 'assign integration_client on ean:EAN-1001 to shire-erp', ok: false },
      { what: 'assign integration_client on ean:EAN-1001 to shire-erp', ok: true },
    ]);
    expect(h.permit.roles.filter((r) => r.user === KEY && r.resource_instance === 'ean:EAN-1001')).toHaveLength(1);
  });

  // Great Eagle's systems keep the request records and take writes with no authentication (backstage), so a record can name
  // anyone. An approval gives integration_client only to a connector of that organization, as Permit's directory marks it.
  it('an approval gives integration scope only to a connector of that organization in Permit, never to a person', async () => {
    const h = s5World();
    await register(h);
    h.permit.attributes.set('rohan-erp', { principal_type: 'integration', owner: 'eowyn', customer: 'riders-of-rohan' });
    const writes = h.permit.log.length;
    for (const [user, why] of [
      ['merry', 'a person'],
      ['rohan-erp', "another organization's connector"],
      ['nobody-erp', 'no user in Permit'],
    ] as const) {
      const record = h.mock.add({ type: 'integration_access', tenant: SHIRE, target: 'ean:EAN-1001', role: 'integration_client', requested_for: user, initiated_by: 'pippin', reason: 'x' });
      const res = await approve(h, 'sam', record.id);
      expect(res.status, why).toBe(409);
      expect(res.body, why).toEqual({ error: `${user} is not an integration of ${SHIRE} in Permit, so it cannot be given integration scope.` });
      expect((await h.mock.getRequest(record.id))?.status, why).toBe('pending');
    }
    expect(h.permit.log).toHaveLength(writes);
    expect(h.permit.roles.filter((r) => r.role === 'integration_client' && r.resource_instance === 'ean:EAN-1001')).toEqual([]);
  });

  it('an approval Permit cannot vouch for is a 502, and the request stays pending', async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    h.deps.permitApi.users.get = async () => {
      throw Object.assign(new Error('Permit API answered 500'), { status: 500 });
    };
    const res = await approve(h, 'sam', filed.id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: `Permit could not say who ${KEY} is: Permit API answered 500` });
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(false);
    expect((await h.mock.getRequest(filed.id))?.status).toBe('pending');
  });

  it('an approved request cannot be approved a second time', async () => {
    const h = s5World();
    await register(h);
    const filed = await askForProduction(h);
    await approve(h, 'sam', filed.id);
    const writes = h.permit.log.length;
    const again = await approve(h, 'sam', filed.id);
    expect(again.status).toBe(409);
    expect(h.permit.log).toHaveLength(writes);
  });
});
