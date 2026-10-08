// S5's persona routes: Pippin registers the connector and asks for production scope, a persona lists their
// organization's connectors with their latest calls, and Sam changes or revokes scope. The PDP decides from the roles
// the fake Permit holds (fakes-s5.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unconfirmed } from './fakes';
import { as, askForProduction, asConnector, approvedForProduction, KEY, NAME, recordCheck, register, s5World, SHIRE, writesOf } from './fakes-s5';

const SANDBOX = { role: 'integration_client', resource: 'ean:EAN-SANDBOX' };

afterEach(() => {
  vi.restoreAllMocks();
});
const requestsPath = (key = KEY) => `/api/s5/integrations/${key}/production-requests`;
const scopePath = (key = KEY) => `/api/s5/integrations/${key}/scope`;

describe('POST /api/s5/integrations', () => {
  it('registration needs register_integration', async () => {
    const h = s5World();
    // Frodo is a member and the admin of EAN-1001, but no developer.
    const res = await as(h.app, 'frodo').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permit denied register_integration on organization:shire-freight.', decision: 'deny' });
    // The refusal comes before everything else: no credential is issued, and Permit is not written to.
    expect(h.mock.integrations).toEqual([]);
    expect(h.permit.log).toEqual([]);
    expect(h.pdp.asked).toEqual([{ user: 'frodo', action: 'register_integration', resource: 'organization:shire-freight' }]);
  });

  it('registers the connector as a Permit user of its own with sandbox scope only, and answers its secret', async () => {
    const h = s5World();
    const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(res.status).toBe(201);
    expect(res.body.integration).toEqual({ key: KEY, name: NAME, owner: 'pippin', customer: SHIRE, customer_name: 'Shire Freight', scope: [SANDBOX], requests: [], recent: [] });
    expect(res.body.client_secret).toBe(h.mock.secretOf(KEY));
    // The answer that carries the secret must not be kept by a cache.
    expect(res.headers['cache-control']).toBe('no-store');
    // The user first, then its one role. No role on a production EAN, and none for Pippin.
    expect(h.permit.log).toEqual([
      ['users.sync', { key: KEY, first_name: NAME, attributes: { principal_type: 'integration', owner: 'pippin', customer: SHIRE } }],
      ['assignRole', 'integration_client', KEY, SHIRE, 'ean:EAN-SANDBOX'],
    ]);
    expect(writesOf(h)).toEqual([{ what: 'assign integration_client on ean:EAN-SANDBOX to shire-erp', ok: true }]);
  });

  it("refuses a key that is a person's, and neither registers it nor touches that person in Permit", async () => {
    const h = s5World();
    for (const key of ['sam', 'frodo', 'pippin', 'aragorn']) {
      expect((await as(h.app, 'pippin').post('/api/s5/integrations', { key, name: NAME })).status, key).toBe(409);
    }
    expect(h.mock.integrations).toEqual([]);
    expect(h.permit.log).toEqual([]);
    expect(h.permit.attributes.get('sam')).toEqual({ identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' });
  });

  it('refuses a key or name the form cannot hold, and registers nothing', async () => {
    const h = s5World();
    const post = (body: object) => as(h.app, 'pippin').post('/api/s5/integrations', body);
    for (const key of ['Shire ERP', 'shire_erp', 'ab', 'a'.repeat(41), '', 7, undefined]) {
      expect((await post({ key, name: NAME })).status, JSON.stringify(key)).toBe(400);
    }
    for (const name of ['', '   ', 'n'.repeat(81), 7, undefined]) {
      expect((await post({ key: KEY, name })).status, JSON.stringify(name)).toBe(400);
    }
    expect(h.mock.integrations).toEqual([]);
    expect(h.permit.log).toEqual([]);
    // The shortest and the longest key, and the longest name, are accepted.
    expect((await post({ key: 'abc', name: 'n'.repeat(80) })).status).toBe(201);
    expect((await post({ key: 'a'.repeat(40), name: NAME })).status).toBe(201);
  });

  it('a write the PDP did not confirm leaves no credential issued, and registering again completes it', async () => {
    const h = s5World();
    // The sandbox role lands at Permit and the PDP does not show it in time: 424.
    h.permit.landedThen.set('assignRole', unconfirmed());
    const first = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(first.status).toBe(424);
    // The credential is the one step a retry cannot repeat, so it comes last: nothing was issued, nothing is lost.
    expect(h.mock.integrations).toEqual([]);

    const retry = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(retry.status).toBe(201);
    expect(retry.body.client_secret).toBe(h.mock.secretOf(KEY));
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-SANDBOX')).toBe(true);
    // The retry writes the sandbox role again, which Permit takes, and the PDP confirms it.
    expect(writesOf(h)).toEqual([
      { what: 'assign integration_client on ean:EAN-SANDBOX to shire-erp', ok: false },
      { what: 'assign integration_client on ean:EAN-SANDBOX to shire-erp', ok: true },
    ]);
  });

  it('a Permit that refuses to create the user is a 502 with its reason, and nothing is issued or assigned', async () => {
    const h = s5World();
    h.deps.permitApi.users.sync = async () => {
      throw Object.assign(new Error('Permit would not create the user'), { status: 422 });
    };
    const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Permit would not create the user' });
    expect(h.mock.integrations).toEqual([]);
    expect(h.permit.log).toEqual([]);
  });

  // The connector becomes a Permit user, and users.sync replaces a user's attributes and keeps its roles: registering under
  // the key of any user Permit already has would take that user over, roles included. Permit's own directory decides.
  it('refuses a key that is already a user in Permit, and neither writes to that user nor issues a credential', async () => {
    const h = s5World();
    // A preflight fixture: a verified admin in its own tenant, in Permit's directory, though no persona and no connector.
    const facts = { identity_verified: true, duplicate_check: 'clear', risk_state: 'ok' };
    h.permit.attributes.set('pf-org-admin', { ...facts });
    h.permit.roles.push({ user: 'pf-org-admin', role: 'org_admin', tenant: 'preflight' });
    const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key: 'pf-org-admin', name: NAME });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'pf-org-admin is already taken.' });
    expect(h.permit.log).toEqual([]);
    expect(h.permit.attributes.get('pf-org-admin')).toEqual(facts);
    expect(h.mock.integrations).toEqual([]);
  });

  it('refuses a connector Permit still holds with production scope when the registry lost it, so a new credential never inherits it', async () => {
    const h = s5World();
    // Great Eagle's systems forgot shire-erp (a restart without STORE_PATH, or a deleted store file); Permit did not.
    h.permit.attributes.set(KEY, { principal_type: 'integration', owner: 'pippin', customer: SHIRE });
    h.permit.roles.push(
      { user: KEY, role: 'integration_client', tenant: SHIRE, resource_instance: 'ean:EAN-SANDBOX' },
      { user: KEY, role: 'integration_client', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
    );
    const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `${KEY} is already taken.` });
    expect(h.permit.log).toEqual([]);
    expect(h.mock.integrations).toEqual([]);
  });

  it("refuses another developer's unfinished registration, and completes Pippin's own from where it stopped", async () => {
    const h = s5World();
    // Merry's registration of the key stopped after the user was written: the user exists, with no role yet.
    h.permit.attributes.set(KEY, { principal_type: 'integration', owner: 'merry', customer: SHIRE });
    const taken = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(taken.status).toBe(409);
    expect(h.permit.log).toEqual([]);
    // Pippin's own, stopped at the same point, is Pippin's to finish: the retry after a 424 must still work.
    h.permit.attributes.set(KEY, { principal_type: 'integration', owner: 'pippin', customer: SHIRE });
    const resumed = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(resumed.status).toBe(201);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-SANDBOX')).toBe(true);
    expect(h.mock.integrations.map((i) => i.key)).toEqual([KEY]);
  });

  it('is a 502, never a free key, when Permit cannot say whether the key is taken, and nothing is written or issued', async () => {
    const h = s5World();
    h.deps.permitApi.users.get = async () => {
      throw Object.assign(new Error('Permit API answered 500'), { status: 500 });
    };
    const res = await as(h.app, 'pippin').post('/api/s5/integrations', { key: KEY, name: NAME });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: `Permit could not say whether ${KEY} is taken: Permit API answered 500` });
    expect(h.permit.log).toEqual([]);
    expect(h.mock.integrations).toEqual([]);
  });

  it("a taken key is refused, and the first connector's owner and secret stay as they were", async () => {
    const h = s5World();
    const secret = await register(h);
    h.permit.roles.push({ user: 'merry', role: 'developer', tenant: SHIRE });
    const writes = h.permit.log.length;
    const res = await as(h.app, 'merry').post('/api/s5/integrations', { key: KEY, name: 'Merry takes over' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    // Nothing was written: the Permit user still names Pippin as the owner.
    expect(h.permit.log).toHaveLength(writes);
    expect(h.permit.attributes.get(KEY)).toEqual({ principal_type: 'integration', owner: 'pippin', customer: SHIRE });
    expect(h.mock.integrations).toHaveLength(1);
    expect(h.mock.secretOf(KEY)).toBe(secret);
  });
});

describe('POST /api/s5/integrations/:key/production-requests', () => {
  it('only the owner requests production', async () => {
    const h = s5World();
    await register(h);
    // Merry is a developer too, but the connector is Pippin's.
    h.permit.roles.push({ user: 'merry', role: 'developer', tenant: SHIRE });
    const refused = await as(h.app, 'merry').post(requestsPath(), { ean: 'EAN-1001', reason: 'I would like it too' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('Peregrin Took');
    expect(await h.mock.listRequests({ type: 'integration_access' })).toEqual([]);

    const filed = await as(h.app, 'pippin').post(requestsPath(), { ean: 'EAN-1001', reason: 'Create shipments from the ERP' });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({
      type: 'integration_access', tenant: SHIRE, target: 'ean:EAN-1001', role: 'integration_client', requested_for: KEY, initiated_by: 'pippin',
      reason: 'Create shipments from the ERP', status: 'pending',
    });
    // A request grants nothing: only an approval writes the connector's role.
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(false);
  });

  it('asks Permit again: a developer who lost the role cannot ask', async () => {
    const h = s5World();
    await register(h);
    h.permit.roles.splice(h.permit.roles.findIndex((r) => r.user === 'pippin' && r.role === 'developer'), 1);
    const res = await as(h.app, 'pippin').post(requestsPath(), { ean: 'EAN-1001', reason: 'Create shipments' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permit denied register_integration on organization:shire-freight.', decision: 'deny' });
    expect(await h.mock.listRequests({ type: 'integration_access' })).toEqual([]);
  });

  it('refuses an unknown connector, an EAN that is not Shire Freight’s and a reason that is missing or too long', async () => {
    const h = s5World();
    await register(h);
    const ask = (key: string, body: object) => as(h.app, 'pippin').post(requestsPath(key), body);
    expect((await ask('nobody', { ean: 'EAN-1001', reason: 'x' })).status).toBe(404);
    // EAN-9999 is in no Permit tenant, EAN-2001 belongs to Riders of Rohan.
    expect((await ask(KEY, { ean: 'EAN-9999', reason: 'x' })).status).toBe(404);
    expect((await ask(KEY, { ean: 'EAN-2001', reason: 'x' })).status).toBe(404);
    expect((await ask(KEY, { ean: 'EAN-1001' })).status).toBe(400);
    expect((await ask(KEY, { ean: 'EAN-1001', reason: '   ' })).status).toBe(400);
    expect((await ask(KEY, { ean: 'EAN-1001', reason: 'r'.repeat(501) })).status).toBe(400);
    expect((await ask(KEY, { reason: 'x' })).status).toBe(400);
    expect(await h.mock.listRequests({ type: 'integration_access' })).toEqual([]);
    expect((await ask(KEY, { ean: 'EAN-1001', reason: 'r'.repeat(500) })).status).toBe(201);
  });
});

describe('GET /api/s5/integrations', () => {
  it('lists each connector with the scope Permit holds now and its own production requests, and never a secret', async () => {
    const h = s5World();
    const secret = await register(h);
    const otherSecret = await register(h, 'other-erp', 'Other ERP');
    const filed = await askForProduction(h);
    const otherFiled = await askForProduction(h, 'other-erp', 'EAN-1002');
    // A role granted outside the portal still shows: the scope is read from Permit, not worked out from the requests.
    h.permit.roles.push({ user: KEY, role: 'integration_reader', tenant: SHIRE, resource_instance: 'ean:EAN-1002' });

    const res = await as(h.app, 'sam').get('/api/s5/integrations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      integrations: [
        {
          key: KEY, name: NAME, owner: 'pippin', customer: SHIRE, customer_name: 'Shire Freight', scope: [SANDBOX, { role: 'integration_reader', resource: 'ean:EAN-1002' }],
          requests: [filed], recent: [],
        },
        {
          key: 'other-erp', name: 'Other ERP', owner: 'pippin', customer: SHIRE, customer_name: 'Shire Freight', scope: [{ role: 'integration_client', resource: 'ean:EAN-SANDBOX' }],
          requests: [otherFiled], recent: [],
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).not.toContain(otherSecret);
    // Pippin reads the same list.
    expect((await as(h.app, 'pippin').get('/api/s5/integrations')).body).toEqual(res.body);
  });

  it('has nothing to list before anything is registered', async () => {
    const h = s5World();
    expect((await as(h.app, 'sam').get('/api/s5/integrations')).body).toEqual({ integrations: [] });
  });

  it('shows a persona of another organization no integrations, and does not ask Permit for them', async () => {
    const h = s5World();
    await register(h);
    const reads = vi.spyOn(h.deps.permitApi.roleAssignments, 'list');
    const asked = h.pdp.asked.length;
    // Éowyn and Éomer belong to Riders of Rohan, Gandalf to Great Eagle, Aragorn to no organization here, and Gríma's
    // registration is still under review: none of them is in Shire Freight.
    for (const persona of ['eowyn', 'eomer', 'gandalf', 'aragorn', 'grima']) {
      const res = await as(h.app, persona).get('/api/s5/integrations');
      expect(res.status, persona).toBe(200);
      expect(res.body, persona).toEqual({ integrations: [] });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(h.pdp.asked).toHaveLength(asked);
    // Shire Freight's own personas still see it.
    for (const persona of ['sam', 'frodo', 'merry', 'pippin']) {
      expect((await as(h.app, persona).get('/api/s5/integrations')).body.integrations, persona).toEqual([expect.objectContaining({ key: KEY })]);
    }
  });

  it("lists the integrations that act for the persona's organization, and no others", async () => {
    const h = s5World();
    await register(h);
    // Registered at Great Eagle's systems for Riders of Rohan, as that organization's own S5 would be.
    await h.mock.registerIntegration({ key: 'rohan-erp', name: 'Rohan ERP', owner: 'eowyn', customer: 'riders-of-rohan' });
    const rohanRequest = h.mock.add({ type: 'integration_access', tenant: 'riders-of-rohan', target: 'ean:EAN-2001', role: 'integration_client', requested_for: 'rohan-erp', initiated_by: 'eowyn', reason: 'Orders' });
    const keysFor = async (persona: string) => ((await as(h.app, persona).get('/api/s5/integrations')).body.integrations as Array<{ key: string }>).map((i) => i.key);
    expect(await keysFor('sam')).toEqual([KEY]);
    expect(await keysFor('eowyn')).toEqual(['rohan-erp']);
    // The requests listed with an integration are those of its own organization, too.
    expect((await as(h.app, 'eowyn').get('/api/s5/integrations')).body.integrations).toEqual([expect.objectContaining({ key: 'rohan-erp', requests: [rohanRequest] })]);
    expect((await as(h.app, 'sam').get('/api/s5/integrations')).body.integrations).toEqual([expect.objectContaining({ key: KEY, requests: [] })]);
  });
});

describe('the recent calls of each integration', () => {
  const T0 = Date.parse('2026-10-07T09:00:00.000Z');
  const at = (ms: number) => T0 + ms;
  const call = (action: string, resource: string, allow: boolean, ms: number) => ({ action, resource, allow, at: at(ms) });
  const recentOf = async (h: ReturnType<typeof s5World>, key = KEY) => {
    const res = await as(h.app, 'sam').get('/api/s5/integrations');
    return (res.body.integrations as Array<{ key: string; recent: unknown }>).find((i) => i.key === key)?.recent;
  };

  it("lists the integration's own checks, newest first, from the moment it was registered on", async () => {
    const h = s5World();
    h.mock.clock = () => T0;
    await register(h);
    h.events.push({ kind: 'write', at: at(1), what: `assign integration_client on ean:EAN-1001 to ${KEY}`, ms: 1, ok: true });
    recordCheck(h, { user: KEY, action: 'create_shipment', resource: 'ean:EAN-1001', allow: true, at: at(-1) }); // an earlier run's call
    recordCheck(h, { user: KEY, action: 'create_shipment', resource: 'ean:EAN-1001', allow: true, at: at(0) }); // the moment of registration counts
    recordCheck(h, { user: 'sam', action: 'approve_integration', resource: 'ean:EAN-1001', allow: true, at: at(1) }); // someone else's check
    recordCheck(h, { user: KEY, action: 'create_shipment', resource: 'ean:EAN-1002', allow: false, at: at(2) });
    recordCheck(h, { user: KEY, action: 'view', resource: 'ean:EAN-1001', allow: true, at: at(3) });
    expect(await recentOf(h)).toEqual([
      call('view', 'ean:EAN-1001', true, 3),
      call('create_shipment', 'ean:EAN-1002', false, 2),
      call('create_shipment', 'ean:EAN-1001', true, 0),
    ]);
  });

  it('keeps each integration to its own calls, and the ten newest of them', async () => {
    const h = s5World();
    h.mock.clock = () => T0;
    await register(h);
    await register(h, 'other-erp', 'Other ERP');
    for (let n = 1; n <= 12; n += 1) recordCheck(h, { user: KEY, action: 'view', resource: `ean:EAN-${n}`, allow: true, at: at(n) });
    recordCheck(h, { user: 'other-erp', action: 'create_shipment', resource: 'ean:EAN-SANDBOX', allow: true, at: at(20) });
    expect(await recentOf(h)).toEqual(Array.from({ length: 10 }, (_unused, i) => call('view', `ean:EAN-${12 - i}`, true, 12 - i)));
    expect(await recentOf(h, 'other-erp')).toEqual([call('create_shipment', 'ean:EAN-SANDBOX', true, 20)]);
  });

  it('shows nothing of the last run once the integration is registered again', async () => {
    const h = s5World();
    h.mock.clock = () => T0;
    await register(h);
    recordCheck(h, { user: KEY, action: 'create_shipment', resource: 'ean:EAN-1001', allow: true, at: at(1) });
    recordCheck(h, { user: KEY, action: 'create_shipment', resource: 'ean:EAN-1002', allow: false, at: at(2) });
    expect(await recentOf(h)).toHaveLength(2);

    // A reset clears Great Eagle's registry, not the portal's log of what happened.
    h.mock.integrations.splice(0);
    h.mock.clock = () => at(1_000);
    await register(h);
    expect(await recentOf(h)).toEqual([]);
    recordCheck(h, { user: KEY, action: 'view', resource: 'ean:EAN-SANDBOX', allow: true, at: at(1_001) });
    expect(await recentOf(h)).toEqual([call('view', 'ean:EAN-SANDBOX', true, 1_001)]);
  });

  it('lists what the connector asked through the integration API, with Permit’s answer to each', async () => {
    const h = s5World();
    const secret = await approvedForProduction(h);
    const connector = asConnector(h.app, secret);
    await connector.post('/api/integration/shipments', { ean: 'EAN-1001', title: 'Pallets' });
    await connector.post('/api/integration/shipments', { ean: 'EAN-1002', title: 'Pallets' });
    await connector.get('/api/integration/shipments?ean=EAN-1001');
    const recent = (await recentOf(h)) as Array<{ action: string; resource: string; allow: boolean; at: number }>;
    expect(recent.map(({ action, resource, allow }) => ({ action, resource, allow }))).toEqual([
      { action: 'view', resource: 'ean:EAN-1001', allow: true },
      { action: 'create_shipment', resource: 'ean:EAN-1002', allow: false },
      { action: 'create_shipment', resource: 'ean:EAN-1001', allow: true },
    ]);
    expect(recent.every((c) => typeof c.at === 'number')).toBe(true);
    expect(recent.map((c) => Object.keys(c).sort())).toEqual(Array(3).fill(['action', 'allow', 'at', 'resource']));
  });
});

describe('POST /api/s5/integrations/:key/scope', () => {
  it('only the organization admin changes scope: Frodo is denied approve_integration, and nothing is written', async () => {
    const h = s5World();
    await approvedForProduction(h);
    const writes = h.permit.log.length;
    for (const level of ['read', 'none']) {
      const res = await as(h.app, 'frodo').post(scopePath(), { ean: 'EAN-1001', level });
      expect(res.status, level).toBe(403);
      expect(res.body, level).toEqual({ error: 'Permit denied approve_integration on ean:EAN-1001.', decision: 'deny' });
    }
    expect(h.permit.log).toHaveLength(writes);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(true);
  });

  it('view-only gives the connector the reader role before it takes the client role away', async () => {
    const h = s5World();
    await approvedForProduction(h);
    const writes = h.permit.log.length;
    const res = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'read' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(h.permit.log.slice(writes)).toEqual([
      ['assignRole', 'integration_reader', KEY, SHIRE, 'ean:EAN-1001'],
      ['unassignRole', 'integration_client', KEY, SHIRE, 'ean:EAN-1001'],
    ]);
    expect(h.permit.holds(KEY, 'integration_reader', SHIRE, 'ean:EAN-1001')).toBe(true);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(false);
    // Only that EAN changed: the sandbox scope is as it was.
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-SANDBOX')).toBe(true);
    // The approved request is the record of what was approved: view-only does not rewrite it.
    expect((await h.mock.listRequests({ type: 'integration_access' }))[0]?.status).toBe('approved');
  });

  it('view-only again changes nothing: the reader role is written again and confirmed, and the client role is already gone', async () => {
    const h = s5World();
    await approvedForProduction(h);
    await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'read' });
    const writes = h.permit.log.length;
    const again = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'read' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ms: expect.any(Number) });
    // Permit takes the repeated reader role (no read before the write); the client role, already gone, is a 404 and done.
    expect(h.permit.log.slice(writes)).toEqual([['assignRole', 'integration_reader', KEY, SHIRE, 'ean:EAN-1001']]);
    expect(h.permit.roles.filter((r) => r.user === KEY).map((r) => `${r.role} ${r.resource_instance}`)).toEqual([
      'integration_client ean:EAN-SANDBOX', 'integration_reader ean:EAN-1001',
    ]);
    expect(writesOf(h).slice(-2)).toEqual([
      { what: 'assign integration_reader on ean:EAN-1001 to shire-erp', ok: true },
      { what: 'unassign integration_client on ean:EAN-1001 from shire-erp (already done)', ok: true },
    ]);
  });

  it('revoke removes both roles on that EAN and nothing else, and marks the approved request revoked by Sam', async () => {
    const h = s5World();
    await approvedForProduction(h);
    // A request nobody has decided stays as it is.
    const waiting = await askForProduction(h, KEY, 'EAN-1002', 'Also the second account');
    const res = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'none' });
    expect(res.status).toBe(200);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-1001')).toBe(false);
    expect(h.permit.holds(KEY, 'integration_reader', SHIRE, 'ean:EAN-1001')).toBe(false);
    expect(h.permit.holds(KEY, 'integration_client', SHIRE, 'ean:EAN-SANDBOX')).toBe(true);
    const requests = await h.mock.listRequests({ type: 'integration_access' });
    expect(requests.map((r) => [r.target, r.status])).toEqual([['ean:EAN-1002', 'pending'], ['ean:EAN-1001', 'revoked']]);
    expect(requests.find((r) => r.id === waiting.id)?.status).toBe('pending');
    expect(requests.find((r) => r.target === 'ean:EAN-1001')?.history.at(-1)).toMatchObject({ status: 'revoked', by: 'sam' });
  });

  it('revoke removes every role the connector holds on that EAN, whatever gave it, and nothing elsewhere', async () => {
    const h = s5World();
    await approvedForProduction(h);
    // A role on EAN-1001 that no approval gave: S8's sync once wrote a legacy user's roles to a connector of the same key.
    h.permit.roles.push({ user: KEY, role: 'account_admin', tenant: SHIRE, resource_instance: 'ean:EAN-1001' });
    h.permit.roles.push({ user: KEY, role: 'account_admin', tenant: SHIRE, resource_instance: 'ean:EAN-1002' });
    const res = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'none' });
    expect(res.status).toBe(200);
    expect(h.permit.roles.filter((r) => r.user === KEY).map((r) => `${r.role} ${r.resource_instance}`)).toEqual([
      'integration_client ean:EAN-SANDBOX', 'account_admin ean:EAN-1002',
    ]);
    expect(writesOf(h).slice(-2)).toEqual([
      { what: 'unassign integration_client on ean:EAN-1001 from shire-erp', ok: true },
      { what: 'unassign account_admin on ean:EAN-1001 from shire-erp', ok: true },
    ]);
  });

  // "Make view-only" swaps the client role for the reader role: it is never a way to give read access the connector
  // does not have. Read access to an EAN comes from an approved request, with the four-eyes rule.
  it('view-only is refused with 409 on an EAN where the connector holds neither role, and nothing is written', async () => {
    const h = s5World();
    const secret = await register(h);
    const writes = h.permit.log.length;
    const res = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1002', level: 'read' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `${NAME} has no access on EAN-1002, so there is nothing to make view-only: access to an EAN comes from an approved request.` });
    expect(h.permit.log).toHaveLength(writes);
    expect((await asConnector(h.app, secret).get('/api/integration/shipments?ean=EAN-1002')).status).toBe(403);
    expect(await h.mock.listRequests({ type: 'integration_access' })).toEqual([]);
  });

  it('is a 502 when Permit cannot list the roles the connector holds, and nothing is written', async () => {
    const h = s5World();
    await approvedForProduction(h);
    const writes = h.permit.log.length;
    h.deps.permitApi.roleAssignments.list = async () => {
      throw Object.assign(new Error('Permit API answered 503'), { status: 503 });
    };
    for (const level of ['read', 'none']) {
      const res = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level });
      expect(res.status, level).toBe(502);
      expect(res.body, level).toEqual({ error: `Permit could not list the roles of ${KEY}: Permit API answered 503` });
    }
    expect(h.permit.log).toHaveLength(writes);
  });

  it('revoke after view-only removes the reader role too, and a second revoke is a no-op', async () => {
    const h = s5World();
    await approvedForProduction(h);
    await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'read' });
    await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'none' });
    expect(h.permit.holds(KEY, 'integration_reader', SHIRE, 'ean:EAN-1001')).toBe(false);
    const writes = h.permit.log.length;
    const again = await as(h.app, 'sam').post(scopePath(), { ean: 'EAN-1001', level: 'none' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ms: 0 });
    expect(h.permit.log).toHaveLength(writes);
  });

  it('refuses a level it does not know, a missing EAN and an unknown connector, writing nothing', async () => {
    const h = s5World();
    await approvedForProduction(h);
    const writes = h.permit.log.length;
    const change = (key: string, body: object) => as(h.app, 'sam').post(scopePath(key), body);
    expect((await change(KEY, { ean: 'EAN-1001', level: 'write' })).status).toBe(400);
    expect((await change(KEY, { ean: 'EAN-1001' })).status).toBe(400);
    expect((await change(KEY, { level: 'none' })).status).toBe(400);
    expect((await change('nobody', { ean: 'EAN-1001', level: 'none' })).status).toBe(404);
    // An EAN Permit does not know is refused by Permit itself: no role is written for it.
    expect((await change(KEY, { ean: 'EAN-9999', level: 'read' })).status).toBe(403);
    expect(h.permit.log).toHaveLength(writes);
  });
});
