import { describe, expect, it } from 'vitest';
import { ensureInstanceRole, ensureNoInstanceRole } from '#src/server/permit/instance-roles';
import { WriteFailedError } from '#src/server/permit/writes';
import { harness, unconfirmed } from '#test/fakes';

const SHIRE = 'shire-freight';

/** The writes the decision panel shows, in order. */
const writesOf = (h: ReturnType<typeof harness>) =>
  h.events.since(0).flatMap((e) => (e.kind === 'write' ? [{ what: e.what, ok: e.ok }] : []));

describe('ensureInstanceRole and ensureNoInstanceRole', () => {
  it('assigns a role on one resource, and the same role on another resource is a write of its own', async () => {
    const h = harness();
    expect(await ensureInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1001')).toBeGreaterThanOrEqual(0);
    await ensureInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1002');
    expect(h.permit.log).toEqual([['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1001'], ['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1002']]);
    expect(writesOf(h)).toEqual([
      { what: 'assign shipper on ean:EAN-1001 to merry', ok: true },
      { what: 'assign shipper on ean:EAN-1002 to merry', ok: true },
    ]);
  });

  it('a role held already is written again and confirmed again, as Permit takes a repeated assignment', async () => {
    const h = harness();
    h.permit.roles.push({ user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' });
    expect(await ensureInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1001')).toBeGreaterThanOrEqual(0);
    expect(h.permit.log).toEqual([['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1001']]);
    expect(h.permit.roles.filter((r) => r.user === 'merry')).toHaveLength(1);
    expect(writesOf(h)).toEqual([{ what: 'assign shipper on ean:EAN-1001 to merry', ok: true }]);
  });

  it('a 409 on assign, should Permit answer one, is done', async () => {
    const h = harness();
    h.permit.quirks.conflictOnHeldInstanceRole = true;
    h.permit.roles.push({ user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' });
    expect(await ensureInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1001')).toBe(0);
    expect(h.permit.log).toEqual([]);
    expect(writesOf(h)).toEqual([{ what: 'assign shipper on ean:EAN-1001 to merry (already done)', ok: true }]);
  });

  it('removes a role on one resource and leaves the same role elsewhere', async () => {
    const h = harness();
    h.permit.roles.push({ user: 'merry', role: 'location_operator', tenant: SHIRE, resource_instance: 'location:LOC-BYWATER' });
    h.permit.roles.push({ user: 'merry', role: 'location_operator', tenant: SHIRE, resource_instance: 'location:LOC-FROGMORTON' });
    await ensureNoInstanceRole(h.deps, 'merry', 'location_operator', SHIRE, 'location:LOC-BYWATER');
    expect(h.permit.holds('merry', 'location_operator', SHIRE, 'location:LOC-BYWATER')).toBe(false);
    expect(h.permit.holds('merry', 'location_operator', SHIRE, 'location:LOC-FROGMORTON')).toBe(true);
    expect(writesOf(h)).toEqual([{ what: 'unassign location_operator on location:LOC-BYWATER from merry', ok: true }]);
  });

  it('a 404 on unassign is done', async () => {
    const h = harness();
    expect(await ensureNoInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1001')).toBe(0);
    expect(h.permit.log).toEqual([]);
    expect(writesOf(h)).toEqual([{ what: 'unassign shipper on ean:EAN-1001 from merry (already done)', ok: true }]);
  });

  it('a write the PDP did not confirm fails with 424, and the retry writes it again and is confirmed', async () => {
    const h = harness();
    h.permit.landedThen.set('assignRole', unconfirmed());
    const failure = await ensureInstanceRole(h.deps, 'merry', 'account_manager', SHIRE, 'account:CA-1001-B').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(WriteFailedError);
    expect((failure as WriteFailedError).status).toBe(424);
    expect(await ensureInstanceRole(h.deps, 'merry', 'account_manager', SHIRE, 'account:CA-1001-B')).toBeGreaterThanOrEqual(0);
    expect(h.permit.roles.filter((r) => r.user === 'merry')).toHaveLength(1);
    expect(writesOf(h)).toEqual([
      { what: 'assign account_manager on account:CA-1001-B to merry', ok: false },
      { what: 'assign account_manager on account:CA-1001-B to merry', ok: true },
    ]);
  });

  it('a tenant role of the same name is not a role on the resource', async () => {
    const h = harness();
    h.permit.roles.push({ user: 'merry', role: 'shipper', tenant: SHIRE });
    expect(await ensureNoInstanceRole(h.deps, 'merry', 'shipper', SHIRE, 'ean:EAN-1001')).toBe(0);
    expect(h.permit.holds('merry', 'shipper', SHIRE)).toBe(true);
  });
});
