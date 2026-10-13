// S2's routes: Team access, which says what each admin may grant and makes the grants, and Merry's
// "What I can do". The PDP is fake, but it answers as the policy does for S2 (test/fakes-s2.ts):
// Sam may grant anywhere, Frodo only inside EAN-1001 and never account_admin, and Merry nothing.
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { harness, permissionsOn, unconfirmed } from '#test/fakes';
import { hold, tenantPermissions, useS2Policy } from '#test/fakes-s2';

const SHIRE = 'shire-freight';
type H = ReturnType<typeof harness>;

const as = (app: Express, persona: string) => ({
  get: (path: string) => request(app).get(path).set('x-demo-persona', persona),
  post: (path: string, body: object = {}) =>
    request(app).post(path).set('x-demo-persona', persona).send(body),
  delete: (path: string, body: object = {}) =>
    request(app).delete(path).set('x-demo-persona', persona).send(body),
});

/** A grant as the form sends it. */
const grantOf = (role: string, resource: string, user = 'merry') => ({ user, role, resource });
/**
 * The grant the console's tester forges: Frodo gives Merry shipper on EAN-1002, which is not
 * Frodo's EAN.
 */
const FORGED = grantOf('shipper', 'ean:EAN-1002');

/** The writes the decision panel shows, in order. */
const writesOf = (h: H) =>
  h.events.since(0).flatMap((e) => (e.kind === 'write' ? [{ what: e.what, ok: e.ok }] : []));
/** Merry's roles on single resources, as Permit holds them. */
const merryRoles = (h: H) =>
  h.permit.roles
    .filter((r) => r.user === 'merry' && r.resource_instance !== undefined)
    .map((r) => `${r.role} ${r.resource_instance}`);
/** What a team answer offers, as "role type:key". */
const offered = (body: { grantable: Array<{ role: string; resource: string }> }) =>
  body.grantable.map((g) => `${g.role} ${g.resource}`);
/** Every decision the fake PDP was asked, as "user action type:key". */
const asked = (h: H) => h.pdp.asked.map((a) => `${a.user} ${a.action} ${a.resource}`);
/** What an assignments answer lists, as "role type:key". */
const listed = (body: { assignments: Array<{ role: string; resource: string }> }) =>
  body.assignments.map((a) => `${a.role} ${a.resource}`);

/**
 * Merry after a run of grants: a role in each of the four places Team access manages, inside
 * EAN-1001 and outside it, in this order.
 */
function merryHolds(h: H) {
  hold(h, 'merry', 'shipper', 'ean:EAN-1001');
  hold(h, 'merry', 'shipper', 'ean:EAN-1002');
  hold(h, 'merry', 'account_admin', 'ean:EAN-1001');
  hold(h, 'merry', 'account_manager', 'account:CA-1001-B');
  hold(h, 'merry', 'account_manager', 'account:CA-1002-A');
  hold(h, 'merry', 'location_operator', 'location:LOC-BYWATER');
  hold(h, 'merry', 'location_operator', 'location:LOC-MICHEL');
}
const MERRYS_SEVEN = [
  'shipper ean:EAN-1001',
  'shipper ean:EAN-1002',
  'account_admin ean:EAN-1001',
  'account_manager account:CA-1001-B',
  'account_manager account:CA-1002-A',
  'location_operator location:LOC-BYWATER',
  'location_operator location:LOC-MICHEL',
];

describe('GET /api/s2/team', () => {
  it("Sam's team lists every grantable pair", async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'sam').get('/api/s2/team');
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      { key: 'sam', name: 'Samwise Gamgee' },
      { key: 'frodo', name: 'Frodo Baggins' },
      { key: 'merry', name: 'Meriadoc Brandybuck' },
      { key: 'pippin', name: 'Peregrin Took' },
    ]);
    expect(res.body.grantable).toEqual([
      { role: 'shipper', resource: 'ean:EAN-1001', name: 'EAN-1001', parent: null },
      { role: 'shipper', resource: 'ean:EAN-1002', name: 'EAN-1002', parent: null },
      { role: 'account_admin', resource: 'ean:EAN-1001', name: 'EAN-1001', parent: null },
      { role: 'account_admin', resource: 'ean:EAN-1002', name: 'EAN-1002', parent: null },
      {
        role: 'account_manager',
        resource: 'account:CA-1001-A',
        name: 'Hobbiton',
        parent: 'ean:EAN-1001',
      },
      {
        role: 'account_manager',
        resource: 'account:CA-1001-B',
        name: 'Bywater',
        parent: 'ean:EAN-1001',
      },
      {
        role: 'account_manager',
        resource: 'account:CA-1002-A',
        name: 'Michel Delving',
        parent: 'ean:EAN-1002',
      },
      {
        role: 'location_operator',
        resource: 'location:LOC-BAGEND',
        name: 'Bag End depot',
        parent: 'account:CA-1001-A',
      },
      {
        role: 'location_operator',
        resource: 'location:LOC-BYWATER',
        name: 'Bywater depot',
        parent: 'account:CA-1001-B',
      },
      {
        role: 'location_operator',
        resource: 'location:LOC-FROGMORTON',
        name: 'Frogmorton depot',
        parent: 'account:CA-1001-B',
      },
      {
        role: 'location_operator',
        resource: 'location:LOC-MICHEL',
        name: 'Michel Delving depot',
        parent: 'account:CA-1002-A',
      },
    ]);
  });

  it("Frodo's team lists only EAN-1001's subtree and no account_admin grant", async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'frodo').get('/api/s2/team');
    expect(res.status).toBe(200);
    expect(offered(res.body)).toEqual([
      'shipper ean:EAN-1001',
      'account_manager account:CA-1001-A',
      'account_manager account:CA-1001-B',
      'location_operator location:LOC-BAGEND',
      'location_operator location:LOC-BYWATER',
      'location_operator location:LOC-FROGMORTON',
    ]);
    // Frodo is asked about every candidate: the form is what Permit allowed, not what the portal
    // left out.
    expect(h.pdp.asked).toHaveLength(11);
  });

  it('asks Permit once, in bulk, one grant_ check for each role on each resource it could go on', async () => {
    const h = harness();
    useS2Policy(h);
    await as(h.app, 'sam').get('/api/s2/team');
    expect(asked(h)).toEqual([
      'sam grant_shipper ean:EAN-1001',
      'sam grant_shipper ean:EAN-1002',
      'sam grant_account_admin ean:EAN-1001',
      'sam grant_account_admin ean:EAN-1002',
      'sam grant_account_manager account:CA-1001-A',
      'sam grant_account_manager account:CA-1001-B',
      'sam grant_account_manager account:CA-1002-A',
      'sam grant_location_operator location:LOC-BAGEND',
      'sam grant_location_operator location:LOC-BYWATER',
      'sam grant_location_operator location:LOC-FROGMORTON',
      'sam grant_location_operator location:LOC-MICHEL',
    ]);
    // One bulk call: every check event says it was one of eleven.
    const checks = h.events.since(0).flatMap((e) => (e.kind === 'check' ? [e] : []));
    expect(checks).toHaveLength(11);
    expect(checks.map((c) => c.bulk)).toEqual(Array(11).fill(11));
    expect(checks.every((c) => c.tenant === SHIRE && c.source === 'action')).toBe(true);
  });

  it('never offers the integration sandbox or an EAN that is not in Permit', async () => {
    const h = harness();
    useS2Policy(h);
    await as(h.app, 'sam').get('/api/s2/team');
    // the form was built from real checks, so the absence below means something
    expect(h.pdp.asked.length).toBeGreaterThan(0);
    expect(asked(h).filter((a) => a.includes('EAN-SANDBOX') || a.includes('EAN-1003'))).toEqual([]);
  });

  it('offers a persona Permit lets grant nothing an empty form, not an error', async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'merry').get('/api/s2/team');
    expect(res.status).toBe(200);
    expect(res.body.grantable).toEqual([]);
  });

  it('is an error, not an empty form, when the PDP does not answer', async () => {
    const h = harness();
    h.pdp.rule = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7766');
    };
    const res = await as(h.app, 'sam').get('/api/s2/team');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'The PDP did not answer. Access is denied.' });
  });
});

describe('GET /api/s2/members/:user/assignments', () => {
  it("lists the member's roles on single resources in Shire Freight, and nothing else", async () => {
    const h = harness();
    // a tenant role is not an assignment on a resource
    h.permit.roles.push({ user: 'merry', role: 'org_member', tenant: SHIRE });
    hold(h, 'merry', 'shipper', 'ean:EAN-1001');
    hold(h, 'merry', 'location_operator', 'location:LOC-BYWATER');
    hold(h, 'frodo', 'account_admin', 'ean:EAN-1001'); // another member's
    h.permit.roles.push({
      user: 'merry',
      role: 'shipper',
      tenant: 'riders-of-rohan-llc',
      resource_instance: 'ean:EAN-9',
    }); // another tenant's
    const res = await as(h.app, 'sam').get('/api/s2/members/merry/assignments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      assignments: [
        { role: 'shipper', resource: 'ean:EAN-1001' },
        { role: 'location_operator', resource: 'location:LOC-BYWATER' },
      ],
    });
  });

  it('reads a role whose resource_instance is null or empty as a role in the tenant, not as one on a resource', async () => {
    const h = harness();
    // A role in the tenant as a looser Permit answer might carry it: no resource, spelt as null or
    // as an empty text.
    const loose = (resource_instance: unknown) => ({
      user: 'merry',
      role: 'org_member',
      tenant: SHIRE,
      resource_instance: resource_instance as string,
    });
    h.deps.permitApi.roleAssignments.list = async () => [
      loose(null),
      loose(''),
      { user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
    ];
    const res = await as(h.app, 'sam').get('/api/s2/members/merry/assignments');
    expect(res.body).toEqual({ assignments: [{ role: 'shipper', resource: 'ean:EAN-1001' }] });
  });

  it('answers an empty list for a member with no roles on resources', async () => {
    const h = harness();
    const res = await as(h.app, 'sam').get('/api/s2/members/pippin/assignments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignments: [] });
  });

  it('answers 400 for someone who is not a member of Shire Freight', async () => {
    const h = harness();
    for (const user of ['aragorn', 'shire-erp', 'lobelia']) {
      const res = await as(h.app, 'sam').get(`/api/s2/members/${user}/assignments`);
      expect(res.status, user).toBe(400);
      expect(res.body.error, user).toBe(`Unknown member ${user}`);
    }
  });

  // The read side keeps the promise the write side makes ("never beyond the administrator's own
  // scope"): a persona is shown only the assignments they could give or take away themselves.
  it("Frodo sees Merry's assignments inside EAN-1001 and not Merry's shipper on EAN-1002", async () => {
    const h = harness();
    useS2Policy(h);
    merryHolds(h);
    const res = await as(h.app, 'frodo').get('/api/s2/members/merry/assignments');
    expect(res.status).toBe(200);
    // Merry's account_admin on EAN-1001 is out of sight too: Frodo may not make an EAN admin, so
    // may not see one made.
    expect(listed(res.body)).toEqual([
      'shipper ean:EAN-1001',
      'account_manager account:CA-1001-B',
      'location_operator location:LOC-BYWATER',
    ]);
  });

  it("Sam sees every one of Merry's assignments, the EAN admin role included", async () => {
    const h = harness();
    useS2Policy(h);
    merryHolds(h);
    const res = await as(h.app, 'sam').get('/api/s2/members/merry/assignments');
    expect(listed(res.body)).toEqual(MERRYS_SEVEN);
  });

  it('asks Permit once, in bulk, for the grant_ action of each assignment on its own resource', async () => {
    const h = harness();
    useS2Policy(h);
    merryHolds(h);
    await as(h.app, 'frodo').get('/api/s2/members/merry/assignments');
    expect(asked(h)).toEqual([
      'frodo grant_shipper ean:EAN-1001',
      'frodo grant_shipper ean:EAN-1002',
      'frodo grant_account_admin ean:EAN-1001',
      'frodo grant_account_manager account:CA-1001-B',
      'frodo grant_account_manager account:CA-1002-A',
      'frodo grant_location_operator location:LOC-BYWATER',
      'frodo grant_location_operator location:LOC-MICHEL',
    ]);
    // One bulk call: every check event says it was one of seven.
    const checks = h.events.since(0).flatMap((e) => (e.kind === 'check' ? [e] : []));
    expect(checks.map((c) => c.bulk)).toEqual(Array(7).fill(7));
    expect(checks.every((c) => c.tenant === SHIRE && c.source === 'action')).toBe(true);
  });

  it('gives a caller who may grant none of them an empty list, not an error', async () => {
    const h = harness();
    useS2Policy(h);
    merryHolds(h);
    const res = await as(h.app, 'merry').get('/api/s2/members/merry/assignments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignments: [] });
    // the answer comes from Permit's denials, not from skipping the question
    expect(h.pdp.asked).toHaveLength(7);
  });

  it('a member with no assignments costs no check', async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'frodo', 'account_admin', 'ean:EAN-1001');
    const sam = as(h.app, 'sam');
    expect((await sam.get('/api/s2/members/pippin/assignments')).body).toEqual({ assignments: [] });
    expect(h.pdp.asked).toEqual([]);
    expect(h.events.since(0)).toEqual([]);
    // The same caller is asked, once, for a member who does hold a role: the silence above is not a
    // PDP that is switched off.
    await sam.get('/api/s2/members/frodo/assignments');
    expect(asked(h)).toEqual(['sam grant_account_admin ean:EAN-1001']);
  });

  it('leaves out, without asking Permit, a role Team access does not manage or a place it does not offer', async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'merry', 'integration_client', 'ean:EAN-1001'); // not a Team access role
    // a Team access role, on the sandbox, which is never on offer
    hold(h, 'merry', 'shipper', 'ean:EAN-SANDBOX');
    // the right role on the wrong kind of resource: shipper is derived there, never given
    hold(h, 'merry', 'shipper', 'account:CA-1001-A');
    hold(h, 'merry', 'shipper', 'ean:EAN-1001'); // the one Team access manages
    const res = await as(h.app, 'sam').get('/api/s2/members/merry/assignments');
    expect(listed(res.body)).toEqual(['shipper ean:EAN-1001']);
    expect(asked(h)).toEqual(['sam grant_shipper ean:EAN-1001']);
  });

  it('is an error, never an empty list, when the PDP does not answer', async () => {
    const h = harness();
    merryHolds(h);
    h.pdp.rule = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7766');
    };
    const res = await as(h.app, 'frodo').get('/api/s2/members/merry/assignments');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'The PDP did not answer. Access is denied.' });
  });
});

describe('POST /api/s2/grants', () => {
  it('Sam grants shipper on EAN-1002: 201 and one confirmed write', async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'sam').post('/api/s2/grants', grantOf('shipper', 'ean:EAN-1002'));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(res.body.ms).toBeGreaterThanOrEqual(0);
    // Permit is asked on that exact resource, and only then is the role written.
    expect(h.permit.log).toEqual([
      ['check', 'sam', 'grant_shipper', 'ean:EAN-1002'],
      ['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1002'],
    ]);
    expect(
      h.events
        .since(0)
        .map((e) =>
          e.kind === 'check'
            ? `check ${e.action} ${e.resource} ${e.allow}`
            : e.kind === 'write'
              ? `write ${e.what} ${e.ok}`
              : e.kind,
        ),
    ).toEqual([
      'check grant_shipper ean:EAN-1002 true',
      'write assign shipper on ean:EAN-1002 to merry true',
    ]);
  });

  it('grants each kind of role on its own kind of resource, each behind its own grant_ check', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    for (const [role, resource] of [
      ['shipper', 'ean:EAN-1001'],
      ['account_manager', 'account:CA-1001-B'],
      ['location_operator', 'location:LOC-BYWATER'],
      ['location_operator', 'location:LOC-FROGMORTON'],
      ['account_admin', 'ean:EAN-1001'],
    ] as const) {
      expect(
        (await sam.post('/api/s2/grants', grantOf(role, resource))).status,
        `${role} ${resource}`,
      ).toBe(201);
    }
    expect(h.permit.log).toEqual([
      ['check', 'sam', 'grant_shipper', 'ean:EAN-1001'],
      ['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1001'],
      ['check', 'sam', 'grant_account_manager', 'account:CA-1001-B'],
      ['assignRole', 'account_manager', 'merry', SHIRE, 'account:CA-1001-B'],
      ['check', 'sam', 'grant_location_operator', 'location:LOC-BYWATER'],
      ['assignRole', 'location_operator', 'merry', SHIRE, 'location:LOC-BYWATER'],
      ['check', 'sam', 'grant_location_operator', 'location:LOC-FROGMORTON'],
      ['assignRole', 'location_operator', 'merry', SHIRE, 'location:LOC-FROGMORTON'],
      ['check', 'sam', 'grant_account_admin', 'ean:EAN-1001'],
      ['assignRole', 'account_admin', 'merry', SHIRE, 'ean:EAN-1001'],
    ]);
  });

  it("Frodo grants inside EAN-1001: a location under it is Frodo's to give", async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'frodo').post(
      '/api/s2/grants',
      grantOf('location_operator', 'location:LOC-FROGMORTON'),
    );
    expect(res.status).toBe(201);
    expect(merryRoles(h)).toEqual(['location_operator location:LOC-FROGMORTON']);
  });

  it('refuses a grant Permit denies, with 403 and no write', async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'frodo').post('/api/s2/grants', FORGED);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Permit denied grant_shipper on ean:EAN-1002.',
      decision: 'deny',
    });
    // Permit was asked, and that is all that happened: no assignment was attempted, so none can
    // have landed.
    expect(h.permit.log).toEqual([['check', 'frodo', 'grant_shipper', 'ean:EAN-1002']]);
    expect(merryRoles(h)).toEqual([]);
    expect(writesOf(h)).toEqual([]);
    expect(h.events.since(0)).toEqual([
      expect.objectContaining({
        kind: 'check',
        user: 'frodo',
        action: 'grant_shipper',
        resource: 'ean:EAN-1002',
        allow: false,
      }),
    ]);
  });

  it('refuses every grant outside the admin scope, whichever kind of role or resource', async () => {
    const h = harness();
    useS2Policy(h);
    const frodo = as(h.app, 'frodo');
    for (const [role, resource, denied] of [
      ['account_manager', 'account:CA-1002-A', 'grant_account_manager'],
      ['location_operator', 'location:LOC-MICHEL', 'grant_location_operator'],
      // A second boundary: even on EAN-1001, which Frodo administers, Frodo cannot make another EAN
      // admin.
      ['account_admin', 'ean:EAN-1001', 'grant_account_admin'],
    ] as const) {
      const res = await frodo.post('/api/s2/grants', grantOf(role, resource));
      expect(res.status, `${role} ${resource}`).toBe(403);
      expect(res.body.error, `${role} ${resource}`).toBe(`Permit denied ${denied} on ${resource}.`);
    }
    expect(merryRoles(h)).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });

  it('refuses a persona with no grant rights at all', async () => {
    const h = harness();
    useS2Policy(h);
    const res = await as(h.app, 'merry').post(
      '/api/s2/grants',
      grantOf('shipper', 'ean:EAN-1001', 'pippin'),
    );
    expect(res.status).toBe(403);
    expect(h.permit.roles.some((r) => r.user === 'pippin')).toBe(false);
  });

  it('a repeated grant changes nothing: Permit takes it again, as staging answers, and the PDP confirms it again', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    const first = await sam.post('/api/s2/grants', grantOf('shipper', 'ean:EAN-1002'));
    const again = await sam.post('/api/s2/grants', grantOf('shipper', 'ean:EAN-1002'));
    expect(first.status).toBe(201);
    // Real Permit answers a role the member holds already with success, not 409 (measured on
    // staging): the portal writes it again and the PDP confirms it again, so the answer is a
    // confirmed write, never an error.
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ms: expect.any(Number) });
    // Nothing changed: Merry holds the role once.
    expect(merryRoles(h)).toEqual(['shipper ean:EAN-1002']);
    expect(h.permit.log.filter((entry) => entry[0] === 'assignRole')).toHaveLength(2);
    // Each request is checked first, the repeat included.
    expect(h.permit.log.filter((entry) => entry[0] === 'check')).toHaveLength(2);
    expect(writesOf(h)).toEqual([
      { what: 'assign shipper on ean:EAN-1002 to merry', ok: true },
      { what: 'assign shipper on ean:EAN-1002 to merry', ok: true },
    ]);
  });

  it('still counts a 409 for a role held already as done, should Permit answer one, with ms 0', async () => {
    const h = harness();
    useS2Policy(h);
    h.permit.quirks.conflictOnHeldInstanceRole = true;
    hold(h, 'merry', 'shipper', 'ean:EAN-1002');
    const again = await as(h.app, 'sam').post('/api/s2/grants', grantOf('shipper', 'ean:EAN-1002'));
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ ms: 0 });
    expect(merryRoles(h)).toEqual(['shipper ean:EAN-1002']);
    expect(writesOf(h)).toEqual([
      { what: 'assign shipper on ean:EAN-1002 to merry (already done)', ok: true },
    ]);
  });

  // The API refuses what the form never offers: Team access lists everyone but the signed-in
  // persona, and a request that names the persona anyway is refused by the portal's own rule before
  // Permit is asked. A self-grant would otherwise give an admin grant rights from a role, which
  // S1's kill switch on the admin's trust facts would not stop.
  it("refuses a grant to the signed-in persona's own access with 403, before Permit is asked, and writes nothing", async () => {
    const h = harness();
    useS2Policy(h);
    for (const [persona, role, resource] of [
      ['sam', 'account_admin', 'ean:EAN-1001'],
      ['frodo', 'location_operator', 'location:LOC-BAGEND'],
    ] as const) {
      const res = await as(h.app, persona).post('/api/s2/grants', grantOf(role, resource, persona));
      expect(res.status, persona).toBe(403);
      expect(res.body, persona).toEqual({ error: "You can't change your own access here." });
    }
    expect(h.pdp.asked).toEqual([]);
    expect(h.permit.log).toEqual([]);
    expect(h.events.since(0)).toEqual([]);
  });

  it('answers 424 when the PDP did not confirm the write, and the retry completes it', async () => {
    const h = harness();
    useS2Policy(h);
    h.permit.landedThen.set('assignRole', unconfirmed());
    const sam = as(h.app, 'sam');
    const failed = await sam.post(
      '/api/s2/grants',
      grantOf('account_manager', 'account:CA-1001-B'),
    );
    expect(failed.status).toBe(424);
    expect(failed.body).toEqual({ error: 'The PDP did not confirm this change within 5 seconds.' });
    const retried = await sam.post(
      '/api/s2/grants',
      grantOf('account_manager', 'account:CA-1001-B'),
    );
    expect(retried.status).toBe(201);
    expect(merryRoles(h)).toEqual(['account_manager account:CA-1001-B']);
  });

  it('writes nothing, and says so, when the PDP does not answer the grant check', async () => {
    const h = harness();
    h.pdp.rule = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7766');
    };
    const res = await as(h.app, 'sam').post('/api/s2/grants', FORGED);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'The PDP did not answer. Access is denied.' });
    expect(h.permit.log).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });

  it('400 for a role on the wrong resource type', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    for (const [role, resource, on] of [
      ['shipper', 'account:CA-1001-A', 'ean'],
      ['account_manager', 'ean:EAN-1001', 'account'],
      ['location_operator', 'account:CA-1001-B', 'location'],
      ['account_admin', 'location:LOC-BAGEND', 'ean'],
    ] as const) {
      const res = await sam.post('/api/s2/grants', grantOf(role, resource));
      expect(res.status, `${role} ${resource}`).toBe(400);
      expect(res.body.error, `${role} ${resource}`).toBe(
        `${role} is granted on ${on}, not on ${resource.slice(0, resource.indexOf(':'))}`,
      );
    }
    // Refused before anything is asked or written.
    expect(h.pdp.asked).toEqual([]);
    expect(h.permit.log).toEqual([]);
  });

  it('400 for an unknown role, an unknown member, or a resource that is not on offer, before Permit is asked anything', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    const refused = [
      [grantOf('owner', 'ean:EAN-1001'), 'Unknown role owner'],
      // Not a Team access role: it comes from S5's approval, and Permit derives it elsewhere.
      [grantOf('integration_client', 'ean:EAN-1001'), 'Unknown role integration_client'],
      [grantOf('shipper', 'ean:EAN-1001', 'aragorn'), 'Unknown member aragorn'],
      [grantOf('shipper', 'ean:EAN-1001', 'shire-erp'), 'Unknown member shire-erp'],
      [grantOf('shipper', 'ean:EAN-9999'), 'Unknown resource ean:EAN-9999'],
      [grantOf('account_manager', 'account:CA-9999-Z'), 'Unknown resource account:CA-9999-Z'],
      // The sandbox is the connector's test scope, and EAN-1003 is not in Permit: neither is a
      // place to grant on.
      [grantOf('shipper', 'ean:EAN-SANDBOX'), 'Unknown resource ean:EAN-SANDBOX'],
      [grantOf('shipper', 'ean:EAN-1003'), 'Unknown resource ean:EAN-1003'],
      [grantOf('shipper', 'EAN-1001'), 'resource must look like type:key'],
      [grantOf('shipper', 'ean:'), 'resource must look like type:key'],
      [grantOf('shipper', ':EAN-1001'), 'resource must look like type:key'],
    ] as const;
    for (const [body, error] of refused) {
      const res = await sam.post('/api/s2/grants', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body, JSON.stringify(body)).toEqual({ error });
    }
    expect(h.pdp.asked).toEqual([]);
    expect(h.permit.log).toEqual([]);
  });

  it('400 for a missing or blank field', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    expect(
      (await sam.post('/api/s2/grants', { role: 'shipper', resource: 'ean:EAN-1001' })).body,
    ).toEqual({ error: 'user is required' });
    expect(
      (await sam.post('/api/s2/grants', { user: 'merry', resource: 'ean:EAN-1001' })).body,
    ).toEqual({ error: 'role is required' });
    expect(
      (await sam.post('/api/s2/grants', { user: 'merry', role: 'shipper', resource: '  ' })).body,
    ).toEqual({ error: 'resource is required' });
    expect(
      (await sam.post('/api/s2/grants', { user: 7, role: 'shipper', resource: 'ean:EAN-1001' }))
        .status,
    ).toBe(400);
    expect(h.permit.log).toEqual([]);
  });
});

describe('DELETE /api/s2/grants', () => {
  it('Sam revokes a role: 200 and one confirmed write, behind the same grant_ check', async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'merry', 'location_operator', 'location:LOC-BYWATER');
    hold(h, 'merry', 'location_operator', 'location:LOC-FROGMORTON');
    const res = await as(h.app, 'sam').delete(
      '/api/s2/grants',
      grantOf('location_operator', 'location:LOC-BYWATER'),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ms: expect.any(Number) });
    expect(h.permit.log).toEqual([
      ['check', 'sam', 'grant_location_operator', 'location:LOC-BYWATER'],
      ['unassignRole', 'location_operator', 'merry', SHIRE, 'location:LOC-BYWATER'],
    ]);
    // The same role on the other depot stays.
    expect(merryRoles(h)).toEqual(['location_operator location:LOC-FROGMORTON']);
    expect(writesOf(h)).toEqual([
      { what: 'unassign location_operator on location:LOC-BYWATER from merry', ok: true },
    ]);
  });

  it('a repeated revoke is a no-op', async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'merry', 'shipper', 'ean:EAN-1001');
    const sam = as(h.app, 'sam');
    expect((await sam.delete('/api/s2/grants', grantOf('shipper', 'ean:EAN-1001'))).status).toBe(
      200,
    );
    const again = await sam.delete('/api/s2/grants', grantOf('shipper', 'ean:EAN-1001'));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ms: 0 });
    expect(writesOf(h)).toEqual([
      { what: 'unassign shipper on ean:EAN-1001 from merry', ok: true },
      { what: 'unassign shipper on ean:EAN-1001 from merry (already done)', ok: true },
    ]);
  });

  it('refuses a revoke Permit denies, with 403, and the role stays', async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'merry', 'shipper', 'ean:EAN-1002');
    const res = await as(h.app, 'frodo').delete('/api/s2/grants', FORGED);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'Permit denied grant_shipper on ean:EAN-1002.',
      decision: 'deny',
    });
    expect(merryRoles(h)).toEqual(['shipper ean:EAN-1002']);
    expect(h.permit.log).toEqual([['check', 'frodo', 'grant_shipper', 'ean:EAN-1002']]);
    expect(writesOf(h)).toEqual([]);
  });

  it("Sam revokes Frodo's account_admin on EAN-1001, and Frodo's own revoke of it is refused before Permit is asked", async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'frodo', 'account_admin', 'ean:EAN-1001');
    const own = await as(h.app, 'frodo').delete(
      '/api/s2/grants',
      grantOf('account_admin', 'ean:EAN-1001', 'frodo'),
    );
    expect(own.status).toBe(403);
    expect(own.body).toEqual({ error: "You can't change your own access here." });
    expect(h.pdp.asked).toEqual([]);
    expect(h.permit.holds('frodo', 'account_admin', SHIRE, 'ean:EAN-1001')).toBe(true);
    const bySam = await as(h.app, 'sam').delete(
      '/api/s2/grants',
      grantOf('account_admin', 'ean:EAN-1001', 'frodo'),
    );
    expect(bySam.status).toBe(200);
    expect(h.permit.holds('frodo', 'account_admin', SHIRE, 'ean:EAN-1001')).toBe(false);
  });

  it("refuses a revoke of the signed-in persona's own access too, whichever role, and the role stays", async () => {
    const h = harness();
    useS2Policy(h);
    hold(h, 'sam', 'shipper', 'ean:EAN-1002');
    const res = await as(h.app, 'sam').delete(
      '/api/s2/grants',
      grantOf('shipper', 'ean:EAN-1002', 'sam'),
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "You can't change your own access here." });
    expect(h.permit.holds('sam', 'shipper', SHIRE, 'ean:EAN-1002')).toBe(true);
    expect(h.pdp.asked).toEqual([]);
    expect(writesOf(h)).toEqual([]);
  });

  it('validates a revoke as it validates a grant', async () => {
    const h = harness();
    useS2Policy(h);
    const sam = as(h.app, 'sam');
    expect(
      (await sam.delete('/api/s2/grants', grantOf('shipper', 'account:CA-1001-A'))).status,
    ).toBe(400);
    expect(
      (await sam.delete('/api/s2/grants', grantOf('shipper', 'ean:EAN-1001', 'aragorn'))).status,
    ).toBe(400);
    expect((await sam.delete('/api/s2/grants', grantOf('owner', 'ean:EAN-1001'))).status).toBe(400);
    expect(h.pdp.asked).toEqual([]);
    expect(h.permit.log).toEqual([]);
  });
});

describe('GET /api/s2/permissions/:user', () => {
  it('permissions rows are sorted EAN, account, location', async () => {
    const h = harness();
    // Merry after Sam's grants, in the order the PDP happens to list them. The tenant's own entry
    // and a shipment are in the answer too, and are not part of the grid.
    h.pdp.userPermissions = () => ({
      ...permissionsOn(
        'location:LOC-FROGMORTON',
        ['location_operator'],
        ['location:view', 'location:operate'],
      ),
      ...tenantPermissions(SHIRE, ['org_member'], ['organization:view_profile']),
      ...permissionsOn(
        'account:CA-1001-B',
        ['account_manager', 'shipper'],
        ['account:view', 'account:ship', 'account:view_billing'],
      ),
      ...permissionsOn('shipment:SHP-77001', ['account_admin'], ['shipment:view']),
      ...permissionsOn('ean:EAN-1002', ['shipper'], ['ean:view', 'ean:ship']),
      ...permissionsOn('account:CA-1002-A', ['shipper'], ['account:view', 'account:ship']),
      ...permissionsOn(
        'location:LOC-BYWATER',
        ['location_operator'],
        ['location:view', 'location:operate'],
      ),
      ...permissionsOn('account:CA-1001-A', ['shipper'], ['account:view', 'account:ship']),
      ...permissionsOn('ean:EAN-1001', ['shipper'], ['ean:view', 'ean:ship']),
    });
    const res = await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { resource: 'ean:EAN-1001', name: 'EAN-1001', roles: ['shipper'], actions: ['view', 'ship'] },
      { resource: 'ean:EAN-1002', name: 'EAN-1002', roles: ['shipper'], actions: ['view', 'ship'] },
      // Hobbiton: shipper, derived from EAN-1001. Bywater adds view_billing: account manager.
      {
        resource: 'account:CA-1001-A',
        name: 'Hobbiton',
        roles: ['shipper'],
        actions: ['view', 'ship'],
      },
      {
        resource: 'account:CA-1001-B',
        name: 'Bywater',
        roles: ['account_manager', 'shipper'],
        actions: ['view', 'ship', 'view_billing'],
      },
      {
        resource: 'account:CA-1002-A',
        name: 'Michel Delving',
        roles: ['shipper'],
        actions: ['view', 'ship'],
      },
      // Bag End is not there: Merry operates two depots only.
      {
        resource: 'location:LOC-BYWATER',
        name: 'Bywater depot',
        roles: ['location_operator'],
        actions: ['view', 'operate'],
      },
      {
        resource: 'location:LOC-FROGMORTON',
        name: 'Frogmorton depot',
        roles: ['location_operator'],
        actions: ['view', 'operate'],
      },
    ]);
  });

  it("asks the PDP for the member's permissions in Shire Freight, once, and records it as one read with no decision", async () => {
    const h = harness();
    h.pdp.userPermissions = () =>
      permissionsOn('ean:EAN-1001', ['shipper'], ['ean:view', 'ean:ship']);
    await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(h.pdp.askedPermissions).toEqual([{ user: 'merry', tenants: [SHIRE] }]);
    expect(h.events.since(0)).toEqual([
      expect.objectContaining({
        kind: 'read',
        user: 'merry',
        tenants: [SHIRE],
        entries: 1,
        source: 'action',
        request: {
          user: { key: 'merry', attributes: { current_time: expect.any(Number) } },
          tenants: [SHIRE],
        },
      }),
    ]);
    // Nothing on the panel says Merry was allowed anything: no check was made.
    expect(h.events.since(0).some((e) => e.kind === 'check')).toBe(false);
  });

  it('accepts actions the PDP lists with or without their type', async () => {
    const h = harness();
    h.pdp.userPermissions = () =>
      permissionsOn('location:LOC-BYWATER', ['location_operator'], ['operate', 'location:view']);
    const res = await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(res.body.rows).toEqual([
      {
        resource: 'location:LOC-BYWATER',
        name: 'Bywater depot',
        roles: ['location_operator'],
        actions: ['operate', 'view'],
      },
    ]);
  });

  it('shows a resource Permit lists without a name of ours by its key, and one with no roles with none', async () => {
    const h = harness();
    h.pdp.userPermissions = () => ({
      'ean:EAN-5000': { permissions: ['ean:view'] },
      'location:LOC-NEW': { permissions: [], roles: [] },
    });
    const res = await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(res.body.rows).toEqual([
      { resource: 'ean:EAN-5000', name: 'EAN-5000', roles: [], actions: ['view'] },
      { resource: 'location:LOC-NEW', name: 'LOC-NEW', roles: [], actions: [] },
    ]);
  });

  it('has no rows when Permit lists nothing on an EAN, account or location', async () => {
    const h = harness();
    h.pdp.userPermissions = () =>
      tenantPermissions(SHIRE, ['org_member'], ['organization:view_profile']);
    const res = await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [] });
  });

  it('is an error, never an empty grid, when the PDP does not answer', async () => {
    const h = harness();
    h.pdp.userPermissions = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:7766');
    };
    const res = await as(h.app, 'merry').get('/api/s2/permissions/merry');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'The PDP did not answer. Access is denied.' });
    expect(h.events.since(0)).toEqual([
      expect.objectContaining({
        kind: 'read',
        user: 'merry',
        error: 'connect ECONNREFUSED 127.0.0.1:7766',
      }),
    ]);
  });

  it("answers 403 for another persona's permissions, and asks Permit nothing", async () => {
    const h = harness();
    // "What I can do" is self-service: Sam, who may grant anything, may not see Merry's grid, and
    // Merry may not see Sam's.
    for (const [persona, user] of [
      ['sam', 'merry'],
      ['frodo', 'merry'],
      ['merry', 'sam'],
      ['sam', 'aragorn'],
    ] as const) {
      const res = await as(h.app, persona).get(`/api/s2/permissions/${user}`);
      expect(res.status, `${persona} asking for ${user}`).toBe(403);
      expect(res.body, `${persona} asking for ${user}`).toEqual({
        error: 'You can only see your own permissions.',
      });
    }
    expect(h.pdp.askedPermissions).toEqual([]);
    expect(h.events.since(0)).toEqual([]);
  });

  it('answers 400 for a persona who is not a member of Shire Freight asking for their own, and asks the PDP nothing', async () => {
    const h = harness();
    const res = await as(h.app, 'aragorn').get('/api/s2/permissions/aragorn');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown member aragorn' });
    expect(h.pdp.askedPermissions).toEqual([]);
  });
});
