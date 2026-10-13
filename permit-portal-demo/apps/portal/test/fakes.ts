// Test doubles shared by the route tests. Permit and the Great Eagle systems mock are faked; the
// portal's own classes (EventLog, DemoClock, Enforcer, FactsWriter, ResourceFactsWriter) are the
// real ones. FakeMock answers every MockClient call, S5's connector registry and shipment store
// included; fakes-s2.ts and fakes-s5.ts hold each scenario's policy and helpers on top of
// harness().
import { randomBytes } from 'node:crypto';
import type { ICheckQuery, IResource, IUser, IUserPermissions } from 'permitio';
import { createApp, type Deps } from '#src/server/app';
import { DemoClock } from '#src/server/clock';
import type { PortalConfig } from '#src/server/config';
import { HttpError } from '#src/server/errors';
import { EventLog } from '#src/server/events';
import type {
  CleanupStatus,
  Doc,
  EanAssociation,
  IntegrationIdentity,
  MockClient,
  MockIntegration,
  MockOrg,
  MockShipment,
  NewIntegration,
  NewRequest,
  NewShipment,
  RegisteredIntegration,
  RequestFilter,
} from '#src/server/mock-client';
import {
  type DemoRequest,
  loadSeed,
  type RequestStatus,
  type SeedData,
  type TrustFacts,
} from '#src/server/model';
import { type CheckClient, Enforcer } from '#src/server/permit/enforcer';
import type { CheckInput, Explainer, Explanation } from '#src/server/permit/explainer';
import { FactsWriter } from '#src/server/permit/facts-writer';
import { ResourceFactsWriter } from '#src/server/permit/resource-facts-writer';

export const NOW = 1_000_000;
export const DAY = 86_400_000;

export const config: PortalConfig = {
  profile: 'test',
  port: 0,
  permit: {
    apiUrl: 'http://permit.invalid',
    apiKey: 'test-api-key',
    pdpUrl: 'http://pdp.invalid',
    proxyFacts: true,
  },
  writes: 'waited',
  greatEagleSystemsUrl: 'http://great-eagle-systems.invalid',
  demoClockEnabled: false,
  grantDemoDurationMs: 120_000,
  permitAppUrl: 'https://app.permit.io',
};

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });
const conflict = () => Object.assign(new Error('Conflict'), { status: 409 });
/** Permit's answer when the local PDP did not confirm a waited write within 5 s. */
export const unconfirmed = () =>
  Object.assign(new Error('Request failed with status code 424'), { status: 424 });
const resourceOf = (r: IResource | string): IResource => (typeof r === 'string' ? { type: r } : r);
const userOf = (u: IUser | string): string => (typeof u === 'string' ? u : u.key);
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * One user-permissions question, as the SDK's getUserPermissions and the PDP's POST
 * /user-permissions take it.
 */
export interface PermissionsQuery {
  user: string;
  tenants?: string[];
  resources?: string[];
  resource_types?: string[];
}

/**
 * One entry of a user-permissions answer, keyed `type:key` as the PDP keys it: the roles the user
 * holds on that resource (derived ones included) and the actions they allow there.
 */
export function permissionsOn(
  resource: string,
  roles: string[],
  permissions: string[] = [],
): IUserPermissions {
  const colon = resource.indexOf(':');
  return {
    [resource]: {
      resource: { type: resource.slice(0, colon), key: resource.slice(colon + 1), attributes: {} },
      permissions,
      roles,
    },
  };
}

/**
 * Decides every check with `rule`, which allows everything until a test changes it, and answers
 * every user-permissions question with `userPermissions`, which lists nothing until a test changes
 * it.
 */
export class FakePdp implements CheckClient {
  rule: (user: string, action: string, resource: IResource) => boolean = () => true;
  readonly asked: Array<{ user: string; action: string; resource: string }> = [];
  /** The PDP's user-permissions answer to `query` (see {@link permissionsOn}). */
  userPermissions: (query: PermissionsQuery) => IUserPermissions = () => ({});
  /** Every user-permissions question, through the SDK or over HTTP, in the order it came. */
  readonly askedPermissions: PermissionsQuery[] = [];
  /**
   * The status POST /user-permissions answers with. Anything but 200 comes without a permission
   * map, as a failing PDP's does.
   */
  httpStatus = 200;

  /** Denies the listed actions for everyone and allows the rest. */
  deny(...actions: string[]): void {
    this.rule = (_user, action) => !actions.includes(action);
  }

  private decide(user: IUser | string, action: string, resource: IResource | string): boolean {
    const r = resourceOf(resource);
    this.asked.push({ user: userOf(user), action, resource: `${r.type}:${r.key ?? '*'}` });
    return this.rule(userOf(user), action, r);
  }

  async check(user: IUser, action: string, resource: IResource): Promise<boolean> {
    return this.decide(user, action, resource);
  }

  async bulkCheck(checks: ICheckQuery[]): Promise<boolean[]> {
    return checks.map((c) => this.decide(c.user, c.action, c.resource));
  }

  async filterObjects<T extends IResource>(
    user: IUser,
    action: string,
    objects: readonly T[],
  ): Promise<T[]> {
    return objects.filter((o) => this.decide(user, action, o));
  }

  /** The SDK's permit.getUserPermissions, with its signature. */
  async getUserPermissions(
    user: IUser | string,
    tenants?: string[],
    resources?: string[],
    resource_types?: string[],
  ): Promise<IUserPermissions> {
    const query: PermissionsQuery = {
      user: userOf(user),
      ...(tenants === undefined ? {} : { tenants }),
      ...(resources === undefined ? {} : { resources }),
      ...(resource_types === undefined ? {} : { resource_types }),
    };
    this.askedPermissions.push(structuredClone(query));
    return structuredClone(this.userPermissions(query));
  }

  /**
   * The PDP's own HTTP API as `fetch` reaches it, for code that calls the PDP without the SDK
   * (PdpSync): POST …/user-permissions answers {@link userPermissions} with {@link httpStatus},
   * anything else 404. Install it with `vi.stubGlobal('fetch', pdp.fetch)`.
   */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((init?.method ?? 'GET') !== 'POST' || !url.pathname.endsWith('/user-permissions'))
      return jsonResponse({ detail: 'Not Found' }, 404);
    const body = JSON.parse(String(init?.body)) as {
      user: { key: string };
      tenants?: string[];
      resources?: string[];
      resource_types?: string[];
    };
    const answer = await this.getUserPermissions(
      body.user.key,
      body.tenants,
      body.resources,
      body.resource_types,
    );
    return this.httpStatus === 200
      ? jsonResponse(answer)
      : jsonResponse({ detail: 'PDP error' }, this.httpStatus);
  };
}

/** A role in a tenant, or on one resource instance (`type:key`) of that tenant. */
interface Assignment {
  user: string;
  role: string;
  tenant: string;
  resource_instance?: string;
}
interface Instance {
  key: string;
  resource: string;
  tenant: string;
  attributes: object;
}

/**
 * Permit's API as the portal uses it, with state, and a log of every write in the order it
 * happened.
 */
export function fakePermit(seed: SeedData) {
  const log: unknown[][] = [];
  const attributes = new Map<string, object>(
    seed.personas.map((p) => [p.key, p.facts ? { ...p.facts } : {}]),
  );
  attributes.set('aragorn', { time_based_grants: [] });
  const tenants = new Map(
    ['shire-freight', 'great-eagle', 'riders-of-rohan-llc', 'preflight'].map((key) => [
      key,
      { key, name: key },
    ]),
  );
  const instances = new Map<string, Instance>();
  const addInstance = (i: Instance) => instances.set(`${i.resource}:${i.key}`, i);
  addInstance({
    key: 'shire-freight',
    resource: 'organization',
    tenant: 'shire-freight',
    attributes: { id: 'shire-freight', ownership_verified: true },
  });
  addInstance({
    key: 'riders-of-rohan-llc',
    resource: 'organization',
    tenant: 'riders-of-rohan-llc',
    attributes: { id: 'riders-of-rohan-llc', ownership_verified: false },
  });
  for (const key of ['EAN-1001', 'EAN-1002'])
    addInstance({
      key,
      resource: 'ean',
      tenant: 'shire-freight',
      attributes: { id: key, association_verified: true },
    });
  const roles: Assignment[] = [
    { user: 'sam', role: 'org_admin', tenant: 'shire-freight' },
    { user: 'frodo', role: 'org_member', tenant: 'shire-freight' },
    { user: 'grima', role: 'pending_member', tenant: 'riders-of-rohan-llc' },
    { user: 'gandalf', role: 'onboarding_reviewer', tenant: 'great-eagle' },
  ];
  const failures: { userUpdate?: unknown; assignRole?: unknown } = {};
  /**
   * How this Permit answers where real ones may differ. Staging answers a role on one resource that
   * the user holds already with success, not 409 (measured on S2's repeated grant), so this fake
   * does too; `conflictOnHeldInstanceRole` brings the 409 back, for the tests of the fallback that
   * still reads it as done.
   */
  const quirks = { conflictOnHeldInstanceRole: false };
  /**
   * One-shot faults by operation: the write is applied (it landed at Permit) and then answers this
   * error, as when the local PDP does not confirm it within 5 s (424). A retry then meets Permit's
   * answer to work already done: 409 for a create or a role in the tenant, 404 for an unassign, and
   * success for a role on one resource, which Permit takes again.
   */
  const landedThen = new Map<
    'tenants.create' | 'resourceInstances.create' | 'assignRole' | 'unassignRole',
    unknown
  >();
  const afterLanding = (op: Parameters<typeof landedThen.set>[0]) => {
    const fault = landedThen.get(op);
    landedThen.delete(op);
    if (fault !== undefined) throw fault;
  };
  /** Whether `user` holds `role` in `tenant` (no `resourceInstance`), or on that one instance. */
  const holds = (user: string, role: string, tenant: string, resourceInstance?: string) =>
    roles.some(
      (r) =>
        r.user === user &&
        r.role === role &&
        r.tenant === tenant &&
        r.resource_instance === resourceInstance,
    );
  /** An instance role's log entry and row end with its `type:key`; a tenant role's are unchanged. */
  const onInstance = (a: { resource_instance?: string }) =>
    a.resource_instance === undefined ? [] : [a.resource_instance];

  const users = {
    async get(key: string) {
      await Promise.resolve();
      const a = attributes.get(key);
      if (!a) throw notFound();
      return { attributes: structuredClone(a) };
    },
    async update(key: string, d: { attributes: object }) {
      if (failures.userUpdate) throw failures.userUpdate;
      log.push(['users.update', key, structuredClone(d.attributes)]);
      attributes.set(key, structuredClone(d.attributes));
      return {};
    },
    /** Creates the user, or replaces its attributes, as api.users.sync does. */
    async sync(u: {
      key: string;
      first_name?: string;
      last_name?: string;
      email?: string;
      attributes?: object;
    }) {
      const created = !attributes.has(u.key);
      log.push(['users.sync', structuredClone(u)]);
      attributes.set(u.key, structuredClone(u.attributes ?? {}));
      return { user: { key: u.key, attributes: structuredClone(u.attributes ?? {}) }, created };
    },
    /**
     * Deletes the user and every role it holds, as api.users.delete does; 404 when there is no such
     * user.
     */
    async delete(key: string) {
      if (!attributes.has(key)) throw notFound();
      log.push(['users.delete', key]);
      attributes.delete(key);
      for (let i = roles.length - 1; i >= 0; i -= 1) if (roles[i]?.user === key) roles.splice(i, 1);
    },
    async assignRole(a: {
      user: string;
      role: string;
      tenant?: string;
      resource_instance?: string;
    }) {
      if (failures.assignRole) throw failures.assignRole;
      const held = holds(a.user, a.role, a.tenant ?? '', a.resource_instance);
      // A role in the tenant that is held already is a 409, as the S1 tests were written against. A
      // role on one resource is taken again and held once, as staging answers it (see `quirks`).
      if (held && (a.resource_instance === undefined || quirks.conflictOnHeldInstanceRole))
        throw conflict();
      log.push(['assignRole', a.role, a.user, a.tenant, ...onInstance(a)]);
      if (!held)
        roles.push({
          user: a.user,
          role: a.role,
          tenant: a.tenant ?? '',
          ...(a.resource_instance === undefined ? {} : { resource_instance: a.resource_instance }),
        });
      afterLanding('assignRole');
      return {};
    },
    async unassignRole(a: {
      user: string;
      role: string;
      tenant: string;
      resource_instance?: string;
    }) {
      const i = roles.findIndex(
        (r) =>
          r.user === a.user &&
          r.role === a.role &&
          r.tenant === a.tenant &&
          r.resource_instance === a.resource_instance,
      );
      if (i < 0) throw notFound();
      log.push(['unassignRole', a.role, a.user, a.tenant, ...onInstance(a)]);
      roles.splice(i, 1);
      afterLanding('unassignRole');
    },
  };
  const tenantsApi = {
    async get(key: string) {
      const t = tenants.get(key);
      if (!t) throw notFound();
      return t;
    },
    async create(t: { key: string; name: string }) {
      if (tenants.has(t.key)) throw conflict();
      log.push(['tenants.create', t]);
      tenants.set(t.key, t);
      afterLanding('tenants.create');
      return t;
    },
  };
  const resourceInstances = {
    async get(key: string) {
      const i = instances.get(key);
      if (!i) throw notFound();
      return { attributes: structuredClone(i.attributes) };
    },
    async update(key: string, d: { attributes: object }) {
      const i = instances.get(key);
      if (!i) throw notFound();
      log.push(['resourceInstances.update', key, structuredClone(d.attributes)]);
      i.attributes = structuredClone(d.attributes);
      return {};
    },
    async create(i: { key: string; resource: string; tenant: string; attributes?: object }) {
      if (instances.has(`${i.resource}:${i.key}`)) throw conflict();
      log.push(['resourceInstances.create', i]);
      addInstance({ ...i, attributes: i.attributes ?? {} });
      afterLanding('resourceInstances.create');
      return i;
    },
    async list(p: { tenant?: string; resource?: string }) {
      return [...instances.values()].filter(
        (i) => (!p.tenant || i.tenant === p.tenant) && (!p.resource || i.resource === p.resource),
      );
    },
  };
  const roleAssignments = {
    async list(p: { tenant?: string; role?: string; user?: string }) {
      return roles
        .filter(
          (r) =>
            (!p.tenant || r.tenant === p.tenant) &&
            (!p.role || r.role === p.role) &&
            (!p.user || r.user === p.user),
        )
        .map((r) => ({ ...r }));
    },
  };
  return {
    log,
    attributes,
    tenants,
    instances,
    roles,
    failures,
    quirks,
    landedThen,
    holds,
    users,
    tenantsApi,
    resourceInstances,
    roleAssignments,
  };
}

const ALLOWED: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ['approved', 'denied', 'canceled'],
  approved: ['revoked', 'expired'],
  denied: [],
  canceled: [],
  revoked: [],
  expired: [],
};

/**
 * A connector as the registry holds it: with the client secret, which no read of the registry
 * returns.
 */
interface Registered extends MockIntegration {
  secret: string;
}

/**
 * The Great Eagle systems mock, in memory, with the state machine of its request workflow and S5's
 * connector registry and shipment store. It answers every call of MockClient, so the app it is
 * given to never meets a missing method.
 */
export class FakeMock implements MockClient {
  readonly baseUrl = 'memory://great-eagle-systems';
  readonly timeoutMs = 0;
  readonly facts = new Map<string, TrustFacts>();
  readonly orgs = new Map<string, MockOrg>();
  readonly requests: DemoRequest[] = []; // newest first, like the mock
  readonly documents = new Map<string, Doc[]>();
  readonly notes: Array<{ user: string; text: string }> = [];
  /** S5: the connectors registered, each with the client secret only the registry keeps. */
  readonly integrations: Registered[] = [];
  /** S5: the shipments connectors created. */
  readonly shipments: MockShipment[] = [];
  /**
   * While set, resolving a credential fails with it, as when Great Eagle's systems cannot be
   * reached.
   */
  resolveFailure: Error | undefined;
  /** When the registry stamps a registration (epoch ms): the wall clock, until a test fixes it. */
  clock: () => number = () => Date.now();
  private seq = 0;

  constructor(private readonly seed: SeedData) {
    for (const p of seed.personas) if (p.facts) this.facts.set(p.key, { ...p.facts });
    for (const o of seed.organizations)
      if (o.in_permit !== 'live')
        this.orgs.set(o.key, {
          key: o.key,
          name: o.name,
          ownership_verified: o.ownership_verified,
        });
    for (const { created_offset_ms: _offset, ...r } of seed.requests)
      this.requests.push({
        ...r,
        created_at: 't0',
        updated_at: 't0',
        history: [{ at: 't0', status: r.status, by: r.initiated_by }],
      });
  }

  /** Files a request directly, in any status, as the mock's own store would hold it. */
  add(r: NewRequest & { status?: RequestStatus }): DemoRequest {
    const request: DemoRequest = {
      ...r,
      id: `req-${++this.seq}`,
      status: r.status ?? 'pending',
      created_at: 't0',
      updated_at: 't0',
      history: [{ at: 't0', status: 'pending', by: r.initiated_by }],
    };
    this.requests.unshift(request);
    return request;
  }

  byId(id: string): DemoRequest {
    const r = this.requests.find((x) => x.id === id);
    if (!r) throw new Error(`no request ${id}`);
    return r;
  }

  async getUserFacts(key: string) {
    return structuredClone(this.facts.get(key) ?? null);
  }
  async getOrg(key: string) {
    return structuredClone(this.orgs.get(key) ?? null);
  }

  async createOrg(key: string, name: string) {
    if (!this.orgs.has(key)) this.orgs.set(key, { key, name, ownership_verified: false });
    return structuredClone(this.orgs.get(key) as MockOrg);
  }

  async associateEan(ean: string, org: string, proof: string, by: string): Promise<EanAssociation> {
    const record = this.seed.eans.find((e) => e.key === ean);
    const reason = !record
      ? `${ean} is not a known EAN`
      : record.org !== org
        ? `${ean} does not belong to ${org}`
        : record.association_proof !== proof
          ? 'The proof does not match the account master'
          : 'Proof matches the account master';
    const valid = reason === 'Proof matches the account master';
    const request = this.add({
      type: 'ean_association',
      tenant: org,
      target: `ean:${ean}`,
      requested_for: by,
      initiated_by: by,
      status: valid ? 'approved' : 'denied',
    });
    return { valid, reason, request: structuredClone(request) };
  }

  async listRequests(f: RequestFilter = {}) {
    const types = f.type === undefined ? undefined : [f.type].flat();
    return structuredClone(
      this.requests.filter(
        (r) =>
          (!f.status || r.status === f.status) &&
          (!types || types.includes(r.type)) &&
          (!f.tenant || r.tenant === f.tenant) &&
          (!f.requested_for || r.requested_for === f.requested_for) &&
          (!f.initiated_by || r.initiated_by === f.initiated_by),
      ),
    );
  }

  async getRequest(id: string) {
    return structuredClone(this.requests.find((r) => r.id === id) ?? null);
  }
  async createRequest(r: NewRequest) {
    return structuredClone(this.add(r));
  }

  async transition(
    id: string,
    to: RequestStatus,
    by: string,
    comment?: string,
    durationMs?: number,
  ) {
    const r = this.requests.find((x) => x.id === id);
    if (!r) throw new HttpError(502, 'Great Eagle systems mock answered 404');
    if (!ALLOWED[r.status].includes(to))
      throw new HttpError(409, `Cannot move a ${r.status} request to ${to}`);
    const decided = to === 'approved' || to === 'denied';
    Object.assign(r, {
      status: to,
      updated_at: 't1',
      ...(decided
        ? { reviewer: by, ...(comment !== undefined ? { reviewer_comment: comment } : {}) }
        : {}),
    });
    if (to === 'approved' && durationMs !== undefined) r.duration_ms = durationMs;
    r.history.push({ at: 't1', status: to, by, ...(comment !== undefined ? { comment } : {}) });
    return structuredClone(r);
  }

  async listDocuments(shipment: string) {
    return structuredClone(this.documents.get(shipment) ?? []);
  }

  async addDocument(shipment: string, name: string, by: string) {
    const doc = { name, by, at: 't1' };
    this.documents.set(shipment, [...(this.documents.get(shipment) ?? []), doc]);
    return doc;
  }

  async notify(user: string, text: string) {
    this.notes.push({ user, text });
  }
  async cleanupStatus(): Promise<CleanupStatus> {
    return {
      intervalMs: 600_000,
      lastRunAt: NOW - 60_000,
      nextRunAt: NOW + 540_000,
      lastRemoved: 0,
      lastError: null,
    };
  }

  /** S5: like the real registry, a taken key is a 409, and the secret is in this answer only. */
  async registerIntegration(i: NewIntegration): Promise<RegisteredIntegration> {
    if (this.integrations.some((existing) => existing.key === i.key))
      throw new HttpError(409, `${i.key} is already registered`);
    const secret = randomBytes(32).toString('hex');
    this.integrations.push({ ...i, created_at: new Date(this.clock()).toISOString(), secret });
    return { ...i, client_secret: secret };
  }

  /** S5: the connector a secret was issued to, or null for one nobody holds. */
  async resolveIntegration(secret: string): Promise<IntegrationIdentity | null> {
    if (this.resolveFailure) throw this.resolveFailure;
    const found = this.integrations.find((i) => i.secret === secret);
    return found ? { key: found.key, customer: found.customer } : null;
  }

  /** S5: every connector, oldest first, never with its secret. */
  async listIntegrations(): Promise<MockIntegration[]> {
    return this.integrations.map(({ secret: _secret, ...listed }) => ({ ...listed }));
  }

  async createShipment(s: NewShipment): Promise<MockShipment> {
    const shipment: MockShipment = {
      key: `SHP-${80_001 + this.shipments.length}`,
      ...s,
      created_at: 't1',
    };
    this.shipments.push(shipment);
    return structuredClone(shipment);
  }

  async listShipments(ean: string): Promise<MockShipment[]> {
    return structuredClone(this.shipments.filter((s) => s.ean === ean));
  }

  /**
   * The client secret a connector was issued: what the connector itself holds, which no read of the
   * registry returns.
   */
  secretOf(key: string): string {
    const found = this.integrations.find((i) => i.key === key);
    if (!found) throw new Error(`no connector ${key}`);
    return found.secret;
  }
}

/**
 * The PDP's `POST /allowed` replay, answering `answer` and recording every input it is asked to
 * explain.
 */
export class FakeExplainer implements Explainer {
  readonly inputs: CheckInput[] = [];
  answer: Explanation = {
    reason: { abac: { allow: false, reason: "user 'aragorn' does not match any rule" } },
    allow: false,
  };

  async explain(input: CheckInput): Promise<Explanation> {
    this.inputs.push(structuredClone(input));
    return structuredClone(this.answer);
  }
}

/** The portal app over fakes, with handles on each fake. The clock is fixed at {@link NOW}. */
export function harness(
  opts: { clockEnabled?: boolean; webDir?: string; eventCapacity?: number } = {},
) {
  const seed = loadSeed();
  const events = new EventLog(opts.eventCapacity);
  const clock = new DemoClock(opts.clockEnabled ?? false, () => NOW);
  const pdp = new FakePdp();
  const explainer = new FakeExplainer();
  const permit = fakePermit(seed);
  const mock = new FakeMock(seed);
  const deps: Deps = {
    config: { ...config, demoClockEnabled: opts.clockEnabled ?? false },
    seed,
    events,
    clock,
    explainer,
    mock,
    enforcer: new Enforcer(pdp, clock, events),
    facts: new FactsWriter(permit.users, events),
    resourceFacts: new ResourceFactsWriter(permit.resourceInstances, events),
    permitApi: {
      users: permit.users,
      tenants: permit.tenantsApi,
      resourceInstances: permit.resourceInstances,
      roleAssignments: permit.roleAssignments,
    },
  };
  return {
    app: createApp(deps, opts.webDir ?? '/nonexistent/portal-web'),
    deps,
    seed,
    events,
    clock,
    pdp,
    explainer,
    permit,
    mock,
  };
}

/** A collaborator grant entry as the FactsWriter stores it. */
export const grant = (resource: string, expires: number, renewals_used = 0) => ({
  resource,
  role: 'collaborator' as const,
  expires,
  renewals_used,
});
