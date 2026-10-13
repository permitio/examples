import { describe, expect, it } from 'vitest';
import { demoData, MATRIX, type PermitData, preflightData } from '#scripts/lib/fixtures';
import { loadSeed, RESOURCE, ROLE, TENANT } from '#src/server/model';

const seed = loadSeed();
const demo = demoData(seed);
const preflight = preflightData(Date.now());

const refOf = (i: { resource: string; key: string }) => `${i.resource}:${i.key}`;
/** The subjects of `child`'s parent tuples: a tuple's subject is the parent, its object the child. */
const parentsOf = (data: PermitData, child: string) =>
  data.tuples.filter((t) => t.relation === 'parent' && t.object === child).map((t) => t.subject);
const keysOf = (data: PermitData, resource: string) =>
  data.instances.filter((i) => i.resource === resource).map((i) => i.key);
const rolesOf = (data: PermitData, user: string) =>
  data.assignments
    .filter((a) => a.user === user)
    .map((a) =>
      a.resource_instance === undefined
        ? `${a.role} in ${a.tenant}`
        : `${a.role} on ${a.resource_instance} in ${a.tenant}`,
    );

describe('demo data', () => {
  it('has 3 accounts, 4 locations and EAN-SANDBOX, each account and location under its parent', () => {
    expect(keysOf(demo, RESOURCE.account)).toEqual(['CA-1001-A', 'CA-1001-B', 'CA-1002-A']);
    expect(keysOf(demo, RESOURCE.location)).toEqual([
      'LOC-BAGEND',
      'LOC-BYWATER',
      'LOC-FROGMORTON',
      'LOC-MICHEL',
    ]);
    expect(demo.instances).toContainEqual({
      resource: RESOURCE.ean,
      key: 'EAN-SANDBOX',
      tenant: TENANT.shire,
      attributes: { association_verified: true, id: 'EAN-SANDBOX' },
    });
    // The parent is the tuple's subject: ean:EAN-1001 is the parent of account:CA-1001-A, never the
    // other way round.
    expect(parentsOf(demo, 'account:CA-1001-A')).toEqual(['ean:EAN-1001']);
    expect(parentsOf(demo, 'ean:EAN-1001')).toEqual([]);
    for (const a of seed.accounts)
      expect(parentsOf(demo, `account:${a.key}`), a.key).toEqual([`ean:${a.ean}`]);
    for (const l of seed.locations)
      expect(parentsOf(demo, `location:${l.key}`), l.key).toEqual([`account:${l.account}`]);
  });

  it('links only instances it creates, inside one tenant', () => {
    const tenantOf = new Map(demo.instances.map((i) => [refOf(i), i.tenant]));
    for (const t of demo.tuples) {
      expect(tenantOf.get(t.subject), `${t.subject} ${t.relation} ${t.object}`).toBe(t.tenant);
      expect(tenantOf.get(t.object), `${t.subject} ${t.relation} ${t.object}`).toBe(t.tenant);
    }
  });

  it('puts merry and pippin in shire-freight with org_member, and gives pippin developer', () => {
    expect(rolesOf(demo, 'merry')).toEqual([`${ROLE.orgMember} in ${TENANT.shire}`]);
    expect(rolesOf(demo, 'pippin')).toEqual([
      `${ROLE.orgMember} in ${TENANT.shire}`,
      `${ROLE.developer} in ${TENANT.shire}`,
    ]);
    for (const key of ['merry', 'pippin'])
      expect(demo.users.find((u) => u.key === key)?.attributes, key).toEqual({});
  });

  it('keeps Frodo the EAN-1001 admin that S8 revokes and its reset restores', () => {
    expect(rolesOf(demo, 'frodo')).toContain(
      `${ROLE.accountAdmin} on ${RESOURCE.ean}:EAN-1001 in ${TENANT.shire}`,
    );
  });
});

describe('preflight fixtures', () => {
  const users = new Set(preflight.users.map((u) => u.key));
  const instances = new Set(preflight.instances.map(refOf));

  it('numbers the matrix 1 to 22, every row on a fixture user and instance', () => {
    expect(MATRIX.map((r) => r.n)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    for (const row of MATRIX) {
      expect(users.has(row.user), `#${row.n} ${row.user}`).toBe(true);
      expect(instances.has(`${row.type}:${row.key}`), `#${row.n} ${row.type}:${row.key}`).toBe(
        true,
      );
      expect(row.tenant, `#${row.n}`).toBe(TENANT.preflight);
    }
  });

  it('gives a deny row a witness whenever its user has no allow row, since a deny proves nothing while the PDP lacks the user', () => {
    const allowed = new Set(MATRIX.filter((r) => r.expect).map((r) => r.user));
    for (const row of MATRIX.filter((r) => !r.expect && !allowed.has(r.user)))
      expect(row.witness, `#${row.n}`).toBeDefined();
  });

  it('checks the grant rights and the connector scope in rows 17 to 22', () => {
    const rows = MATRIX.filter((r) => r.n >= 17).map((r) => ({
      n: r.n,
      check: `${r.user} ${r.action} ${r.type}:${r.key}`,
      expect: r.expect,
      ...(r.witness ? { witness: r.witness.action } : {}),
    }));
    expect(rows).toEqual([
      { n: 17, check: 'pf-ean-admin grant_shipper ean:PF-E1', expect: true },
      { n: 18, check: 'pf-ean-admin grant_shipper ean:PF-E2', expect: false },
      { n: 19, check: 'pf-ean-admin grant_location_operator location:PF-L1', expect: true },
      { n: 20, check: 'pf-org-admin grant_location_operator location:PF-L2', expect: true },
      { n: 21, check: 'pf-connector create_shipment ean:PF-E1', expect: true },
      { n: 22, check: 'pf-connector create_shipment ean:PF-E2', expect: false, witness: 'view' },
    ]);
  });

  it('builds the chains those rows read: PF-E1 > PF-A1 > PF-L1, PF-E2 > PF-A2 > PF-L2', () => {
    expect(parentsOf(preflight, 'account:PF-A1')).toEqual(['ean:PF-E1']);
    expect(parentsOf(preflight, 'account:PF-A2')).toEqual(['ean:PF-E2']);
    expect(parentsOf(preflight, 'location:PF-L1')).toEqual(['account:PF-A1']);
    expect(parentsOf(preflight, 'location:PF-L2')).toEqual(['account:PF-A2']);
    expect(rolesOf(preflight, 'pf-org-admin')).toEqual([`${ROLE.orgAdmin} in ${TENANT.preflight}`]);
    expect(preflight.users.find((u) => u.key === 'pf-org-admin')?.attributes).toEqual({
      identity_verified: true,
      duplicate_check: 'clear',
      risk_state: 'ok',
    });
    expect(rolesOf(preflight, 'pf-connector')).toEqual([
      `${ROLE.integrationClient} on ean:PF-E1 in ${TENANT.preflight}`,
      `${ROLE.integrationReader} on ean:PF-E2 in ${TENANT.preflight}`,
    ]);
  });
});
