// A role on a single resource is confirmed by reading the user's roles on that resource from the PDP's
// user-permissions answer, with the deadline, interval, first wait and 424 of every other confirmed write.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { statusOf } from '../src/server/errors';
import { loadSeed } from '../src/server/model';
import { confirmedWrites } from '../src/server/permit/confirmed-writes';
import { PdpSync, PdpSyncTimeout, SYNC_TIMING } from '../src/server/permit/pdp-sync';
import { describeWriteError } from '../src/server/permit/writes';
import { FakePdp, fakePermit, permissionsOn } from './fakes';

const SHIRE = 'shire-freight';
const SHIPPER_ON_1001 = { user: 'merry', role: 'shipper', tenant: SHIRE, resource_instance: 'ean:EAN-1001' };

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
}

/** Permit's API and the PDP, faked, behind the portal's confirmed writes with the real timing. */
function setup() {
  const permit = fakePermit(loadSeed());
  const pdp = new FakePdp();
  vi.stubGlobal('fetch', pdp.fetch);
  const time = fakeTime();
  const writes = confirmedWrites({ users: permit.users } as never, new PdpSync('http://pdp:7000/', 'test-api-key', SYNC_TIMING, time.sleep, time.now));
  return { permit, pdp, time, writes };
}

/** The user-permissions question the confirmation asks the PDP each time. */
const question = (user: string, resource: string) => ({ user, tenants: [SHIRE], resources: [resource] });

afterEach(() => vi.unstubAllGlobals());

describe('confirming a role on a single resource', () => {
  it('assigning a single-resource role waits until the PDP lists it', async () => {
    const { permit, pdp, time, writes } = setup();
    // The PDP lists the new role from its third answer on, as if the write took 650 ms to reach it.
    pdp.userPermissions = () => (pdp.askedPermissions.length >= 3 ? permissionsOn('ean:EAN-1001', ['shipper'], ['ean:view', 'ean:ship']) : {});
    await writes.users.assignRole(SHIPPER_ON_1001);
    expect(permit.log).toEqual([['assignRole', 'shipper', 'merry', SHIRE, 'ean:EAN-1001']]);
    expect(pdp.askedPermissions).toEqual([1, 2, 3].map(() => question('merry', 'ean:EAN-1001')));
    expect(time.at()).toBe(SYNC_TIMING.firstMs + 2 * SYNC_TIMING.everyMs);
  });

  it('unassigning waits until it is gone, even while another role still shows on that resource', async () => {
    const { permit, pdp, time, writes } = setup();
    permit.roles.push({ user: 'merry', role: 'account_manager', tenant: SHIRE, resource_instance: 'account:CA-1001-B' });
    // Merry keeps shipper on the account (derived from Merry's shipper role on EAN-1001), so the entry stays after the removal.
    pdp.userPermissions = () => permissionsOn('account:CA-1001-B', pdp.askedPermissions.length < 3 ? ['account_manager', 'shipper'] : ['shipper']);
    await writes.users.unassignRole({ user: 'merry', role: 'account_manager', tenant: SHIRE, resource_instance: 'account:CA-1001-B' });
    expect(permit.log).toEqual([['unassignRole', 'account_manager', 'merry', SHIRE, 'account:CA-1001-B']]);
    expect(pdp.askedPermissions).toHaveLength(3);
    expect(time.at()).toBe(SYNC_TIMING.firstMs + 2 * SYNC_TIMING.everyMs);
  });

  it('424 after 5 s', async () => {
    const { pdp, time, writes } = setup();
    const failure = await writes.users.assignRole(SHIPPER_ON_1001).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PdpSyncTimeout);
    expect(statusOf(failure)).toBe(424);
    expect(describeWriteError(failure)).toBe('The PDP did not confirm this change within 5 seconds.');
    expect(time.at()).toBeLessThanOrEqual(SYNC_TIMING.deadlineMs);
    expect(time.at()).toBeGreaterThan(SYNC_TIMING.deadlineMs - 2 * SYNC_TIMING.everyMs);
    expect(pdp.askedPermissions.length).toBeGreaterThan(40);
  });

  it('reads the role on that resource only, not on another one or in the tenant', async () => {
    const { pdp, writes } = setup();
    pdp.userPermissions = () => ({
      ...permissionsOn('ean:EAN-1002', ['shipper']),
      '__tenant:shire-freight': { tenant: { key: SHIRE, attributes: {} }, permissions: ['organization:view_profile'], roles: ['org_member', 'shipper'] },
    });
    await expect(writes.users.assignRole(SHIPPER_ON_1001)).rejects.toBeInstanceOf(PdpSyncTimeout);
  });

  it('never takes a PDP that does not answer for a role that is gone', async () => {
    const { permit, pdp, writes } = setup();
    permit.roles.push({ ...SHIPPER_ON_1001 });
    pdp.httpStatus = 503;
    await expect(writes.users.unassignRole(SHIPPER_ON_1001)).rejects.toBeInstanceOf(PdpSyncTimeout);
    expect(pdp.askedPermissions.length).toBeGreaterThan(40);
  });

  it("confirms a 409, should Permit answer one, on the PDP before passing it on, so a retried step does not move on while the PDP is behind", async () => {
    const { permit, pdp, writes } = setup();
    permit.quirks.conflictOnHeldInstanceRole = true;
    permit.roles.push({ ...SHIPPER_ON_1001 });
    pdp.userPermissions = () => permissionsOn('ean:EAN-1001', ['shipper']);
    const failure = await writes.users.assignRole(SHIPPER_ON_1001).catch((e: unknown) => e);
    expect(statusOf(failure)).toBe(409);
    expect(pdp.askedPermissions).toEqual([question('merry', 'ean:EAN-1001')]);
    expect(permit.log).toEqual([]);
  });

  it('asks the PDP itself, at /user-permissions, with the API key', async () => {
    const { pdp } = setup();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return pdp.fetch(input, init);
    });
    pdp.userPermissions = () => permissionsOn('location:LOC-BYWATER', ['location_operator']);
    const time = fakeTime();
    await new PdpSync('http://pdp:7000/', 'test-api-key', SYNC_TIMING, time.sleep, time.now)
      .untilInstanceRole('merry', SHIRE, 'location:LOC-BYWATER', 'location_operator', true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://pdp:7000/user-permissions');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer test-api-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ user: { key: 'merry' }, tenants: [SHIRE], resources: ['location:LOC-BYWATER'] });
  });
});
