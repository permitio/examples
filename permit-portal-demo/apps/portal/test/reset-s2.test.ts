// S2's reset hook: take back every role on a single resource in Shire Freight that a member holds
// and the seed does not give (Team access grants to every member, not only Merry), and nothing
// else.
import type { Permit } from 'permitio';
import { describe, expect, it } from 'vitest';
import { resetS2 } from '#scripts/reset/s2';

interface Row {
  user: string;
  role: string;
  tenant: string;
  resource_instance?: string;
}

const SHIRE = 'shire-freight';
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

/**
 * Permit's role-assignment API as the hook calls it, with state: `list` filters as Permit does, and
 * `unassign` answers 404 for a role not held. A resource in `goneBefore` loses its role to someone
 * else between the list and the unassign; `failOn` makes the unassign on that resource fail with
 * `error`. A role in the tenant has no `resource_instance` in the rows `list` answers, or has it as
 * null when `wire` is 'null': the hook must read both as "not on a resource".
 */
function fakeAssignments(
  rows: Row[],
  opts: {
    goneBefore?: string[];
    failOn?: { resource: string; error: Error };
    wire?: 'absent' | 'null';
  } = {},
) {
  const asked: unknown[] = [];
  const unassigned: Row[] = [];
  const permit = {
    api: {
      roleAssignments: {
        async list(p: { user?: string; tenant?: string }) {
          asked.push(p);
          return rows
            .filter((r) => (!p.user || r.user === p.user) && (!p.tenant || r.tenant === p.tenant))
            .map((r) =>
              r.resource_instance === undefined && opts.wire === 'null'
                ? { ...r, resource_instance: null }
                : { ...r },
            );
        },
        async unassign(u: Row) {
          if (opts.failOn !== undefined && opts.failOn.resource === u.resource_instance)
            throw opts.failOn.error;
          const i = rows.findIndex(
            (r) =>
              r.user === u.user &&
              r.role === u.role &&
              r.tenant === u.tenant &&
              r.resource_instance === u.resource_instance,
          );
          const racedAway = opts.goneBefore?.includes(u.resource_instance ?? '') === true;
          if (i >= 0 && racedAway) rows.splice(i, 1); // someone else's removal got there first
          if (i < 0 || racedAway) throw notFound();
          unassigned.push(...rows.splice(i, 1));
        },
      },
    },
  } as unknown as Permit;
  return { permit, asked, unassigned, rows };
}

const startingRows = (): Row[] => [
  { user: 'merry', role: 'org_member', tenant: SHIRE },
  { user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
  { user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1002' },
  { user: 'merry', role: 'account_manager', tenant: SHIRE, resource_instance: 'account:CA-1001-B' },
  {
    user: 'merry',
    role: 'location_operator',
    tenant: SHIRE,
    resource_instance: 'location:LOC-BYWATER',
  },
  { user: 'frodo', role: 'account_admin', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
  { user: 'pippin', role: 'developer', tenant: SHIRE },
  { user: 'merry', role: 'shipper', tenant: 'riders-of-rohan-llc', resource_instance: 'ean:EAN-9' },
];

/**
 * What a presenter can leave behind in Team access besides Merry's roles: one for each of the other
 * members.
 */
const othersRows = (): Row[] => [
  { user: 'sam', role: 'org_admin', tenant: SHIRE },
  { user: 'sam', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1002' },
  { user: 'frodo', role: 'org_member', tenant: SHIRE },
  { user: 'frodo', role: 'account_manager', tenant: SHIRE, resource_instance: 'account:CA-1001-B' },
  {
    user: 'pippin',
    role: 'location_operator',
    tenant: SHIRE,
    resource_instance: 'location:LOC-BAGEND',
  },
  // Not a member of Shire Freight: the connector is resetS5's, and Aragorn is no one Team access
  // grants to.
  {
    user: 'shire-erp',
    role: 'integration_client',
    tenant: SHIRE,
    resource_instance: 'ean:EAN-SANDBOX',
  },
  { user: 'aragorn', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
];

describe('resetS2', () => {
  it.each(['absent', 'null'] as const)(
    "unassigns every role Merry holds on a single resource in Shire Freight, and leaves everything else (a tenant role's resource_instance %s)",
    async (wire) => {
      const { permit, asked, unassigned, rows } = fakeAssignments(startingRows(), { wire });
      const lines: string[] = [];
      await resetS2(permit, (line) => lines.push(line));
      // Each member of Shire Freight is read, in the seed's order.
      expect(asked).toEqual(
        ['sam', 'frodo', 'merry', 'pippin'].map((user) => ({ user, tenant: SHIRE })),
      );
      expect(unassigned.map((r) => `${r.role} ${r.resource_instance}`)).toEqual([
        'shipper ean:EAN-1001',
        'shipper ean:EAN-1002',
        'account_manager account:CA-1001-B',
        'location_operator location:LOC-BYWATER',
      ]);
      // Merry's place in the organization, Frodo's EAN admin role (the seed gives it), Pippin's
      // tenant role and another tenant's roles stay.
      expect(rows.map((r) => `${r.user} ${r.role} ${r.resource_instance ?? r.tenant}`)).toEqual([
        `merry org_member ${SHIRE}`,
        'frodo account_admin ean:EAN-1001',
        `pippin developer ${SHIRE}`,
        'merry shipper ean:EAN-9',
      ]);
      expect(lines).toHaveLength(4);
      for (const line of lines)
        expect(line).toMatch(/^ {2}done {5}role .+ for merry on .+ removed$/);
    },
  );

  it('takes back what Team access gave the other members too, and keeps only what the seed gives', async () => {
    const { permit, unassigned, rows } = fakeAssignments([...startingRows(), ...othersRows()]);
    const lines: string[] = [];
    await resetS2(permit, (line) => lines.push(line));
    // Frodo as an account manager on Bywater would otherwise outlive the reset, and keep
    // view_billing there after S8 revokes Frodo's EAN admin role; Sam's own role on EAN-1002 and
    // Pippin's depot would carry over into the next run.
    expect(unassigned.map((r) => `${r.user} ${r.role} ${r.resource_instance}`)).toEqual([
      'sam shipper ean:EAN-1002',
      'frodo account_manager account:CA-1001-B',
      'merry shipper ean:EAN-1001',
      'merry shipper ean:EAN-1002',
      'merry account_manager account:CA-1001-B',
      'merry location_operator location:LOC-BYWATER',
      'pippin location_operator location:LOC-BAGEND',
    ]);
    expect(
      rows
        .filter((r) => r.resource_instance !== undefined)
        .map((r) => `${r.user} ${r.role} ${r.resource_instance}`),
    ).toEqual([
      'frodo account_admin ean:EAN-1001',
      'merry shipper ean:EAN-9',
      'shire-erp integration_client ean:EAN-SANDBOX',
      'aragorn shipper ean:EAN-1001',
    ]);
    expect(lines).toContain(
      '  done     role account_manager for frodo on account:CA-1001-B removed',
    );
  });

  it.each(['absent', 'null'] as const)(
    "has nothing to do when no member holds a role the seed does not give, and says so (a tenant role's resource_instance %s)",
    async (wire) => {
      const seeded: Row[] = [
        { user: 'merry', role: 'org_member', tenant: SHIRE },
        { user: 'frodo', role: 'account_admin', tenant: SHIRE, resource_instance: 'ean:EAN-1001' },
      ];
      const { permit, unassigned } = fakeAssignments(seeded, { wire });
      const lines: string[] = [];
      await resetS2(permit, (line) => lines.push(line));
      expect(unassigned).toEqual([]);
      expect(lines).toEqual(["  none     S2, members' roles on single resources beyond the seed"]);
    },
  );

  it('takes a 404 for a role that is already gone, and goes on to the next', async () => {
    const { permit, rows } = fakeAssignments(startingRows(), { goneBefore: ['ean:EAN-1002'] });
    const lines: string[] = [];
    await resetS2(permit, (line) => lines.push(line));
    expect(
      rows.filter(
        (r) => r.user === 'merry' && r.resource_instance !== undefined && r.tenant === SHIRE,
      ),
    ).toEqual([]);
    expect(lines.filter((l) => l.startsWith('  absent'))).toEqual([
      '  absent   role shipper for merry on ean:EAN-1002 removed',
    ]);
    expect(lines.filter((l) => l.startsWith('  done'))).toHaveLength(3);
  });

  it('does not hide any other failure', async () => {
    const boom = Object.assign(new Error('Permit says no'), { status: 500 });
    const { permit } = fakeAssignments(startingRows(), {
      failOn: { resource: 'ean:EAN-1002', error: boom },
    });
    await expect(resetS2(permit, () => {})).rejects.toBe(boom);
  });
});
