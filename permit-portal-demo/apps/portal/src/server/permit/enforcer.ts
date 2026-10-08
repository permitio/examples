import type { ICheckQuery, IResource, IUser, IUserPermissions } from 'permitio';
import { HttpError, messageOf } from '../errors';
import type { EventLog, EventSource } from '../events';
import type { CheckInput } from './explainer';

export interface ResourceRef { type: string; key: string; tenant: string; attributes?: Record<string, unknown> }

/** The part of the Permit SDK the enforcer uses. The real `Permit` instance satisfies it. */
export interface CheckClient {
  check(u: IUser, a: string, r: IResource): Promise<boolean>;
  bulkCheck(checks: ICheckQuery[]): Promise<boolean[]>;
  filterObjects<T extends IResource>(u: IUser, a: string, objs: readonly T[]): Promise<T[]>;
  getUserPermissions(u: IUser, tenants: string[]): Promise<IUserPermissions>;
}

/** Every decision says why it ran, so the panel can tell actions from background refreshes and guards. */
export interface CheckOptions { source: EventSource; label?: string }

interface Outcome { allow: boolean; ms: number; bulk?: number; error?: string }

const PDP_DOWN = 'The PDP did not answer. Access is denied.';

/**
 * The portal's enforcement point. Every decision goes through the SDK with the user's `current_time` and
 * the resource's `id` attached, is timed around the SDK call and is recorded for the decision panel. Permit's
 * reason is not fetched here: the panel asks for it on demand (`POST /api/events/:id/explain`), so each decision
 * reaches Permit's Audit Log once.
 */
export class Enforcer {
  constructor(
    private readonly client: CheckClient,
    private readonly clock: { now(): number },
    private readonly events: EventLog,
  ) {}

  user(key: string): IUser {
    return { key, attributes: { current_time: this.clock.now() } };
  }

  resource(r: ResourceRef): IResource {
    return { type: r.type, key: r.key, tenant: r.tenant, attributes: { ...r.attributes, id: r.key } };
  }

  async check(userKey: string, action: string, ref: ResourceRef, opts: CheckOptions): Promise<boolean> {
    const input: CheckInput = { user: this.user(userKey), action, resource: this.resource(ref) };
    const start = performance.now();
    let allow: boolean;
    try {
      // Permit SDK: permit.check(user, action, resource) asks the local PDP whether this user may do this action on
      // this resource, and gets true or false. The PDP decides on its own copy of the policy and data (roles,
      // relationships, attributes), so a check never waits on Permit's cloud.
      allow = await this.client.check(input.user, action, input.resource);
    } catch (e) {
      this.record(userKey, ref, input, opts, { allow: false, ms: performance.now() - start, error: messageOf(e) });
      throw new HttpError(503, PDP_DOWN);
    }
    this.record(userKey, ref, input, opts, { allow, ms: performance.now() - start });
    return allow;
  }

  async bulk(userKey: string, items: Array<{ action: string; ref: ResourceRef }>, opts: CheckOptions): Promise<boolean[]> {
    if (items.length === 0) return [];
    const user = this.user(userKey);
    const pairs = items.map(({ action, ref }) => ({ ref, input: { user, action, resource: this.resource(ref) } }));
    const start = performance.now();
    let results: boolean[];
    try {
      // Permit SDK: permit.bulkCheck(checks) sends several checks to the PDP in one request and gets one true/false
      // per check, in order. A page's ALLOW/DENY chips and Aragorn's live checks come from here.
      results = await this.client.bulkCheck(pairs.map((p) => p.input));
    } catch (e) {
      const failed = { allow: false, ms: performance.now() - start, bulk: items.length, error: messageOf(e) };
      for (const p of pairs) this.record(userKey, p.ref, p.input, opts, failed);
      throw new HttpError(503, PDP_DOWN);
    }
    const ms = performance.now() - start;
    return pairs.map((p, i) => {
      const allow = results[i] === true;
      this.record(userKey, p.ref, p.input, opts, { allow, ms, bulk: items.length });
      return allow;
    });
  }

  async filter<T extends ResourceRef>(userKey: string, action: string, refs: T[], opts: CheckOptions): Promise<T[]> {
    if (refs.length === 0) return [];
    const user = this.user(userKey);
    const pairs = refs.map((ref) => ({ ref, input: { user, action, resource: this.resource(ref) } }));
    const start = performance.now();
    let allowed: Array<IResource & { ref: T }>;
    try {
      // Permit SDK: permit.filterObjects(user, action, resources) runs one bulk check over a list and returns only the
      // resources the user may act on, so the shipment list and an organization's EANs show only what Permit allows.
      allowed = await this.client.filterObjects(user, action, pairs.map((p) => ({ ...p.input.resource, ref: p.ref })));
    } catch (e) {
      const failed = { allow: false, ms: performance.now() - start, bulk: refs.length, error: messageOf(e) };
      for (const p of pairs) this.record(userKey, p.ref, p.input, opts, failed);
      throw new HttpError(503, PDP_DOWN);
    }
    const ms = performance.now() - start;
    const kept = new Set(allowed.map((o) => o.ref));
    for (const p of pairs) this.record(userKey, p.ref, p.input, opts, { allow: kept.has(p.ref), ms, bulk: refs.length });
    return allowed.map((o) => o.ref);
  }

  /**
   * What the PDP says `userKey` may do in `tenants`, resource by resource (S2's "What I can do"). The answer is a list, not
   * an allow or a deny, so the panel records it as a read of its own: the request exactly as it was sent and how many
   * entries came back, with no decision, no directory sign and nothing to replay. A PDP that does not answer is a 503 here
   * too, never an empty map: an empty map would read as the PDP saying "nothing".
   */
  async permissions(userKey: string, tenants: string[], opts: CheckOptions = { source: 'action' }): Promise<IUserPermissions> {
    const request = { user: this.user(userKey), tenants };
    const read = { kind: 'read', user: userKey, tenants, source: opts.source, request } as const;
    const start = performance.now();
    let answer: IUserPermissions;
    try {
      // Permit SDK: permit.getUserPermissions(user, tenants) asks the local PDP for everything this user may do in these
      // tenants: a map keyed type:key, each entry listing the roles the user holds there (derived ones included, such as
      // shipper on a child account from shipper on its EAN) and the actions those roles allow.
      answer = await this.client.getUserPermissions(request.user, tenants);
    } catch (e) {
      this.events.push({ ...read, at: Date.now(), ms: performance.now() - start, error: messageOf(e) });
      throw new HttpError(503, PDP_DOWN);
    }
    this.events.push({ ...read, at: Date.now(), ms: performance.now() - start, entries: Object.keys(answer).length });
    return answer;
  }

  private record(userKey: string, ref: ResourceRef, input: CheckInput, opts: CheckOptions, outcome: Outcome): void {
    this.events.push({
      kind: 'check', at: Date.now(), user: userKey, action: input.action, resource: `${ref.type}:${ref.key}`, tenant: ref.tenant,
      source: opts.source, ...(opts.label === undefined ? {} : { label: opts.label }), input, ...outcome,
    });
  }
}
