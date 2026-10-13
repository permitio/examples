import type { ICheckQuery, IResource, IUser, IUserPermissions } from 'permitio';
import { describe, expect, it } from 'vitest';
import { HttpError } from '#src/server/errors';
import { EventLog } from '#src/server/events';
import { type CheckClient, Enforcer } from '#src/server/permit/enforcer';

const resourceOf = (r: IResource | string): IResource => (typeof r === 'string' ? { type: r } : r);

/** A PDP stand-in that records what the enforcer sends it. */
class RecordingClient implements CheckClient {
  readonly checks: Array<{ user: IUser; action: string; resource: IResource }> = [];
  readonly bulks: ICheckQuery[][] = [];
  readonly filters: Array<{ user: IUser; action: string; objects: readonly IResource[] }> = [];
  readonly permissionQueries: Array<{ user: IUser; tenants: string[] }> = [];
  allow: (action: string, resource: IResource) => boolean = () => true;
  /** What the PDP answers to a user-permissions question. */
  permissions: IUserPermissions = {};
  failure: Error | undefined;

  async check(user: IUser, action: string, resource: IResource): Promise<boolean> {
    this.checks.push({ user, action, resource });
    if (this.failure) throw this.failure;
    return this.allow(action, resource);
  }

  async bulkCheck(checks: ICheckQuery[]): Promise<boolean[]> {
    this.bulks.push(checks);
    if (this.failure) throw this.failure;
    return checks.map((c) => this.allow(c.action, resourceOf(c.resource)));
  }

  async filterObjects<T extends IResource>(
    user: IUser,
    action: string,
    objects: readonly T[],
  ): Promise<T[]> {
    this.filters.push({ user, action, objects });
    if (this.failure) throw this.failure;
    return objects.filter((o) => this.allow(action, o));
  }

  async getUserPermissions(user: IUser, tenants: string[]): Promise<IUserPermissions> {
    this.permissionQueries.push({ user, tenants });
    if (this.failure) throw this.failure;
    return this.permissions;
  }
}

function setup() {
  const client = new RecordingClient();
  const events = new EventLog();
  const enforcer = new Enforcer(client, { now: () => 1_234_567 }, events);
  return { client, events, enforcer };
}

const shp = (key: string, attributes?: Record<string, unknown>) => ({
  type: 'shipment',
  key,
  tenant: 'shire-freight',
  ...(attributes ? { attributes } : {}),
});
const action = { source: 'action' } as const;

describe('Enforcer', () => {
  it('sends the clock as the user attribute current_time', async () => {
    const { client, enforcer } = setup();
    await enforcer.check('aragorn', 'view', shp('SHP-77001'), action);
    expect(client.checks[0]?.user).toEqual({
      key: 'aragorn',
      attributes: { current_time: 1_234_567 },
    });
  });

  it('sends the resource key as the id attribute, with extra attributes, and id always wins', async () => {
    const { client, enforcer } = setup();
    await enforcer.check(
      'aragorn',
      'request_renewal',
      shp('SHP-77001', { requested_days: 7, id: 'SHP-SPOOFED' }),
      action,
    );
    expect(client.checks[0]?.resource).toEqual({
      type: 'shipment',
      key: 'SHP-77001',
      tenant: 'shire-freight',
      attributes: { requested_days: 7, id: 'SHP-77001' },
    });
  });

  it('records each check with its decision, latency, source and exact input, and no reason', async () => {
    const { client, enforcer, events } = setup();
    client.allow = () => false;
    await expect(
      enforcer.check('aragorn', 'view', shp('SHP-77001'), { source: 'refresh', label: 'detail' }),
    ).resolves.toBe(false);
    const event = events.since(0)[0];
    expect(event).toMatchObject({
      kind: 'check',
      user: 'aragorn',
      action: 'view',
      resource: 'shipment:SHP-77001',
      tenant: 'shire-freight',
      allow: false,
      label: 'detail',
      source: 'refresh',
      input: { user: client.checks[0]?.user, action: 'view', resource: client.checks[0]?.resource },
    });
    expect(event?.kind === 'check' && typeof event.ms === 'number' && event.ms >= 0).toBe(true);
    expect(event).not.toHaveProperty('bulk');
    // Permit's reason is fetched only on demand (POST /api/events/:id/explain), never with the
    // decision.
    expect(event).not.toHaveProperty('reason');
  });

  it('tags each decision with the source it is given', async () => {
    const { enforcer, events } = setup();
    await enforcer.check(
      'eowyn',
      'manage_members',
      { type: 'organization', key: 'nw', tenant: 'nw' },
      { source: 'guard' },
    );
    await enforcer.bulk('aragorn', [{ action: 'view', ref: shp('A') }], { source: 'refresh' });
    await enforcer.filter('aragorn', 'view', [shp('B')], { source: 'action' });
    expect(events.since(0).map((e) => (e.kind === 'check' ? e.source : ''))).toEqual([
      'guard',
      'refresh',
      'action',
    ]);
  });

  it('denies with 503 and records the error when the PDP does not answer', async () => {
    const { client, enforcer, events } = setup();
    client.failure = new Error('connect ECONNREFUSED 127.0.0.1:7766');
    const error = await enforcer
      .check('aragorn', 'view', shp('SHP-77001'), action)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 503,
      message: 'The PDP did not answer. Access is denied.',
    });
    expect(events.since(0)).toEqual([
      expect.objectContaining({
        kind: 'check',
        allow: false,
        source: 'action',
        error: 'connect ECONNREFUSED 127.0.0.1:7766',
      }),
    ]);
  });

  it('bulk sends one bulkCheck and returns the decisions in order, one event per item', async () => {
    const { client, enforcer, events } = setup();
    client.allow = (_action, r) => r.key === 'SHP-77001';
    const results = await enforcer.bulk(
      'aragorn',
      [
        { action: 'view', ref: shp('SHP-77001') },
        { action: 'view', ref: shp('SHP-77002') },
        {
          action: 'view_profile',
          ref: { type: 'organization', key: 'shire-freight', tenant: 'shire-freight' },
        },
      ],
      action,
    );
    expect(results).toEqual([true, false, false]);
    expect(client.bulks).toHaveLength(1);
    expect(
      client.bulks[0]?.map((c) => [
        c.action,
        resourceOf(c.resource).key,
        (c.user as IUser).attributes,
      ]),
    ).toEqual([
      ['view', 'SHP-77001', { current_time: 1_234_567 }],
      ['view', 'SHP-77002', { current_time: 1_234_567 }],
      ['view_profile', 'shire-freight', { current_time: 1_234_567 }],
    ]);
    expect(
      events
        .since(0)
        .map((e) => (e.kind === 'check' ? [e.action, e.resource, e.allow, e.bulk] : [])),
    ).toEqual([
      ['view', 'shipment:SHP-77001', true, 3],
      ['view', 'shipment:SHP-77002', false, 3],
      ['view_profile', 'organization:shire-freight', false, 3],
    ]);
    expect(events.since(0).some((e) => 'reason' in e)).toBe(false);
  });

  it('bulk with nothing to check asks the PDP nothing', async () => {
    const { client, enforcer, events } = setup();
    await expect(enforcer.bulk('aragorn', [], action)).resolves.toEqual([]);
    expect(client.bulks).toHaveLength(0);
    expect(events.since(0)).toHaveLength(0);
  });

  it('bulk denies with 503 and records one error event per item when the PDP does not answer', async () => {
    const { client, enforcer, events } = setup();
    client.failure = new Error('timeout');
    await expect(
      enforcer.bulk(
        'aragorn',
        [
          { action: 'view', ref: shp('A') },
          { action: 'view', ref: shp('B') },
        ],
        action,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(events.since(0)).toEqual([
      expect.objectContaining({ resource: 'shipment:A', allow: false, bulk: 2, error: 'timeout' }),
      expect.objectContaining({ resource: 'shipment:B', allow: false, bulk: 2, error: 'timeout' }),
    ]);
  });

  it('filter returns the original refs that are allowed, in order, and records each decision', async () => {
    const { client, enforcer, events } = setup();
    client.allow = (_action, r) => r.key !== 'SHP-77002';
    const refs = [shp('SHP-77001'), shp('SHP-77002'), shp('SHP-77003')];
    const visible = await enforcer.filter('aragorn', 'view', refs, action);
    expect(visible).toEqual([refs[0], refs[2]]);
    expect(visible[0]).toBe(refs[0]);
    expect(visible[1]).toBe(refs[2]);
    expect(client.filters[0]?.objects[0]).toMatchObject({
      type: 'shipment',
      key: 'SHP-77001',
      tenant: 'shire-freight',
      attributes: { id: 'SHP-77001' },
    });
    expect(
      events.since(0).map((e) => (e.kind === 'check' ? [e.resource, e.allow, e.bulk] : [])),
    ).toEqual([
      ['shipment:SHP-77001', true, 3],
      ['shipment:SHP-77002', false, 3],
      ['shipment:SHP-77003', true, 3],
    ]);
  });
});

describe('Enforcer.permissions', () => {
  const mapOf = (): IUserPermissions => ({
    'ean:EAN-1001': {
      resource: { type: 'ean', key: 'EAN-1001', attributes: {} },
      permissions: ['ean:view', 'ean:ship'],
      roles: ['shipper'],
    },
  });

  it("asks the PDP for the user's permissions in the tenants, as the user with current_time, and returns its map as it is", async () => {
    const { client, enforcer } = setup();
    client.permissions = mapOf();
    const answer = await enforcer.permissions('merry', ['shire-freight']);
    expect(answer).toBe(client.permissions);
    expect(client.permissionQueries).toEqual([
      {
        user: { key: 'merry', attributes: { current_time: 1_234_567 } },
        tenants: ['shire-freight'],
      },
    ]);
  });

  // A user-permissions read asks for a list, not a yes or no: the panel must never show it as a
  // check (no ALLOW, no directory sign, no "input" the PDP never received). It is recorded as a
  // read, with the request exactly as it was sent.
  it('records one read for the whole answer, with the request as it was sent and how many entries came back, and no decision', async () => {
    const { client, enforcer, events } = setup();
    client.permissions = {
      ...mapOf(),
      'account:CA-1001-A': { permissions: ['account:view'], roles: ['shipper'] },
    };
    await enforcer.permissions('merry', ['shire-freight']);
    const recorded = events.since(0);
    expect(recorded).toEqual([
      {
        id: 1,
        kind: 'read',
        at: expect.any(Number),
        user: 'merry',
        tenants: ['shire-freight'],
        source: 'action',
        ms: expect.any(Number),
        request: {
          user: { key: 'merry', attributes: { current_time: 1_234_567 } },
          tenants: ['shire-freight'],
        },
        entries: 2,
      },
    ]);
    // What the panel shows as sent is what the PDP was asked.
    expect(client.permissionQueries).toEqual([
      recorded[0]?.kind === 'read' ? recorded[0].request : undefined,
    ]);
    for (const field of ['allow', 'action', 'resource', 'input', 'error'])
      expect(recorded[0], field).not.toHaveProperty(field);
  });

  it('tags the read with the source it is given', async () => {
    const { enforcer, events } = setup();
    await enforcer.permissions('merry', ['shire-freight'], { source: 'refresh' });
    expect(events.since(0).map((e) => [e.kind, e.kind === 'write' ? '' : e.source])).toEqual([
      ['read', 'refresh'],
    ]);
  });

  it('names every tenant it asks about, and none when it names none', async () => {
    const { client, enforcer, events } = setup();
    await enforcer.permissions('merry', ['shire-freight', 'great-eagle']);
    await enforcer.permissions('merry', []);
    expect(client.permissionQueries.map((q) => q.tenants)).toEqual([
      ['shire-freight', 'great-eagle'],
      [],
    ]);
    expect(events.since(0).map((e) => (e.kind === 'read' ? e.tenants : undefined))).toEqual([
      ['shire-freight', 'great-eagle'],
      [],
    ]);
  });

  it('denies with 503 and records the failed read when the PDP does not answer, never an empty map', async () => {
    const { client, enforcer, events } = setup();
    client.failure = new Error('connect ECONNREFUSED 127.0.0.1:7766');
    const error = await enforcer.permissions('merry', ['shire-freight']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      status: 503,
      message: 'The PDP did not answer. Access is denied.',
    });
    expect(events.since(0)).toEqual([
      expect.objectContaining({
        kind: 'read',
        user: 'merry',
        tenants: ['shire-freight'],
        source: 'action',
        error: 'connect ECONNREFUSED 127.0.0.1:7766',
      }),
    ]);
    // A failed read counts no entries: it is not an answer that listed nothing.
    expect(events.since(0)[0]).not.toHaveProperty('entries');
  });
});
