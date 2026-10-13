import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmedWrites } from '#src/server/permit/confirmed-writes';
import { holds, PdpSync, PdpSyncTimeout, PdpSyncUnavailable, type PdpView, rolesIn, SYNC_ACTION } from '#src/server/permit/pdp-sync';
import { describeWriteError } from '#src/server/permit/writes';

const debugAnswer = (user: object, resource: object = {}) => ({ allow: false, debug: { request: { user: { key: 'x', attributes: user }, resource: { type: 'organization', attributes: resource } } } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A clock that only moves when the code under test sleeps. */
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
}

afterEach(() => vi.unstubAllGlobals());

describe('PdpSync.view', () => {
  it('sends a pdp_sync check and reads the user and resource as the PDP evaluated them', async () => {
    const fetchMock = vi.fn(async () => json(debugAnswer({ risk_state: 'ok', roles: ['org_admin'] }, { ownership_verified: true })));
    vi.stubGlobal('fetch', fetchMock);
    const view = await new PdpSync('http://pdp:7000/', 'key').view('eowyn', { type: 'organization', key: 'nw', tenant: 'nw' });
    expect(view).toEqual({ user: { risk_state: 'ok', roles: ['org_admin'] }, resource: { ownership_verified: true } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://pdp:7000/allowed');
    expect(JSON.parse(String(init.body))).toEqual({ user: { key: 'eowyn' }, action: SYNC_ACTION, resource: { type: 'organization', key: 'nw', tenant: 'nw' }, context: {} });
  });

  it('answers undefined when the PDP fails or cannot be reached, so polling goes on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    expect(await new PdpSync('http://pdp', 'k').view('u', { type: 't', key: 'k', tenant: 'd' })).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await new PdpSync('http://pdp', 'k').view('u', { type: 't', key: 'k', tenant: 'd' })).toBeUndefined();
  });

  it('refuses at once when debug mode is off, since nothing can be confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ allow: false })));
    await expect(new PdpSync('http://pdp', 'k').view('u', { type: 't', key: 'k', tenant: 'd' })).rejects.toBeInstanceOf(PdpSyncUnavailable);
  });
});

describe('PdpSync.until', () => {
  it('waits firstMs, then polls every everyMs until the PDP holds the change', async () => {
    const answers = [debugAnswer({ risk_state: 'ok' }), debugAnswer({ risk_state: 'ok' }), debugAnswer({ risk_state: 'suspended' })];
    vi.stubGlobal('fetch', vi.fn(async () => json(answers.shift())));
    const time = fakeTime();
    const sync = new PdpSync('http://pdp', 'k', { firstMs: 300, everyMs: 100, deadlineMs: 5_000 }, time.sleep, time.now);
    await sync.until('eowyn', { type: 'organization', key: 'p', tenant: 'default' }, (v) => holds(v.user, { risk_state: 'suspended' }));
    expect(time.at()).toBe(500);
    expect(answers).toHaveLength(0);
  });

  it('fails with a 424 at the deadline, which the routes report as the waited path does', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(debugAnswer({}))));
    const time = fakeTime();
    const sync = new PdpSync('http://pdp', 'k', { firstMs: 300, everyMs: 100, deadlineMs: 1_000 }, time.sleep, time.now);
    const failure = await sync.until('aragorn', { type: 'organization', key: 'p', tenant: 'default' }, () => false).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PdpSyncTimeout);
    expect(describeWriteError(failure)).toBe('The PDP did not confirm this change within 5 seconds.');
    expect(time.at()).toBeLessThanOrEqual(1_000);
  });
});

describe('holds and rolesIn', () => {
  it('compares every written key whatever the key order, and ignores keys it did not write', () => {
    const held = { roles: [], time_based_grants: [{ expires: 5, renewals_used: 0, resource: 'SHP-77001', role: 'collaborator' }] };
    expect(holds(held, { time_based_grants: [{ resource: 'SHP-77001', role: 'collaborator', expires: 5, renewals_used: 0 }] })).toBe(true);
    expect(holds(held, { time_based_grants: [] })).toBe(false);
    expect(holds({ identity_verified: false }, { identity_verified: true })).toBe(false);
  });

  it('lists the roles the PDP holds in the probed tenant', () => {
    expect(rolesIn({ user: { roles: ['org_admin', 7] }, resource: {} })).toEqual(['org_admin']);
    expect(rolesIn({ user: {}, resource: {} })).toEqual([]);
  });
});

/** A PdpSync whose view is whatever `held` says when it is asked, recording what it was asked about. */
function fakeSync(held: () => PdpView) {
  const asked: Array<{ user: string; resource: object }> = [];
  const sync = {
    async until(user: string, resource: object, ready: (v: PdpView) => boolean) {
      asked.push({ user, resource });
      if (!ready(held())) throw new PdpSyncTimeout('not there');
    },
  };
  return { sync: sync as unknown as PdpSync, asked };
}

describe('confirmedWrites', () => {
  const api = (overrides: Record<string, unknown> = {}) => ({
    users: { get: vi.fn(), update: vi.fn(async () => ({})), assignRole: vi.fn(async () => ({})), unassignRole: vi.fn(async () => undefined), ...(overrides['users'] as object) },
    resourceInstances: { get: vi.fn(), list: vi.fn(), create: vi.fn(async () => ({})), update: vi.fn(async () => ({ tenant: 'nw' })), ...(overrides['resourceInstances'] as object) },
  });

  it('confirms a user attribute write against the PDP, probing a tenant every environment has', async () => {
    const a = api();
    const { sync, asked } = fakeSync(() => ({ user: { risk_state: 'suspended' }, resource: {} }));
    await confirmedWrites(a as never, sync).users.update('eowyn', { attributes: { risk_state: 'suspended' } });
    expect(a.users.update).toHaveBeenCalledWith('eowyn', { attributes: { risk_state: 'suspended' } });
    expect(asked).toEqual([{ user: 'eowyn', resource: { type: 'organization', key: 'pdp-sync', tenant: 'default' } }]);
  });

  it('passes the PDP timeout on when the write never shows', async () => {
    const { sync } = fakeSync(() => ({ user: { risk_state: 'ok' }, resource: {} }));
    await expect(confirmedWrites(api() as never, sync).users.update('eowyn', { attributes: { risk_state: 'suspended' } })).rejects.toBeInstanceOf(PdpSyncTimeout);
  });

  it('confirms an assigned role in its tenant, also when Permit says it was already assigned', async () => {
    const { sync, asked } = fakeSync(() => ({ user: { roles: ['org_admin'] }, resource: {} }));
    await confirmedWrites(api() as never, sync).users.assignRole({ user: 'eowyn', role: 'org_admin', tenant: 'nw' });
    expect(asked).toEqual([{ user: 'eowyn', resource: { type: 'organization', key: 'pdp-sync', tenant: 'nw' } }]);

    const conflict = Object.assign(new Error('exists'), { status: 409 });
    const again = fakeSync(() => ({ user: { roles: ['org_admin'] }, resource: {} }));
    const a = api({ users: { assignRole: vi.fn(async () => { throw conflict; }) } });
    await expect(confirmedWrites(a as never, again.sync).users.assignRole({ user: 'eowyn', role: 'org_admin', tenant: 'nw' })).rejects.toBe(conflict);
    expect(again.asked).toHaveLength(1);
  });

  it('confirms an unassigned role is gone, also when Permit says there was nothing to remove', async () => {
    const { sync } = fakeSync(() => ({ user: { roles: [] }, resource: {} }));
    await confirmedWrites(api() as never, sync).users.unassignRole({ user: 'grima', role: 'pending_member', tenant: 'llc' });
    const missing = Object.assign(new Error('gone'), { status: 404 });
    const a = api({ users: { unassignRole: vi.fn(async () => { throw missing; }) } });
    await expect(confirmedWrites(a as never, sync).users.unassignRole({ user: 'grima', role: 'pending_member', tenant: 'llc' })).rejects.toBe(missing);
  });

  it('does not confirm when the write itself fails for another reason', async () => {
    const { sync, asked } = fakeSync(() => ({ user: {}, resource: {} }));
    const boom = Object.assign(new Error('boom'), { status: 500 });
    const a = api({ users: { assignRole: vi.fn(async () => { throw boom; }) } });
    await expect(confirmedWrites(a as never, sync).users.assignRole({ user: 'eowyn', role: 'org_admin', tenant: 'nw' })).rejects.toBe(boom);
    expect(asked).toEqual([]);
  });

  it('confirms resource instances by their attributes, finding an updated instance tenant from the answer', async () => {
    const { sync, asked } = fakeSync(() => ({ user: {}, resource: { association_verified: true, ownership_verified: true } }));
    const writes = confirmedWrites(api() as never, sync);
    await writes.resourceInstances.create({ key: 'EAN-2001', resource: 'ean', tenant: 'nw', attributes: { association_verified: true } });
    await writes.resourceInstances.update('organization:nw', { attributes: { ownership_verified: true } });
    expect(asked).toEqual([
      { user: 'pdp-sync', resource: { type: 'ean', key: 'EAN-2001', tenant: 'nw' } },
      { user: 'pdp-sync', resource: { type: 'organization', key: 'nw', tenant: 'nw' } },
    ]);
  });
});
