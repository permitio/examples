import type { IResource } from 'permitio';

/**
 * The action the sync probe checks. No resource type has it, so the probe is always denied and is easy to tell apart
 * in Permit's Audit Log (action `pdp_sync`).
 */
export const SYNC_ACTION = 'pdp_sync';

/** What the local PDP holds, read from the `request` part of a probe check's debug block. */
export interface PdpView {
  /** The user's attributes as the PDP sees them, including `roles` in the probed tenant. */
  user: Record<string, unknown>;
  /** The resource instance's attributes as the PDP sees them. */
  resource: Record<string, unknown>;
}

export interface SyncTiming {
  /** Wait this long after the write before the first probe: propagation to the PDP takes about half a second. */
  firstMs: number;
  /** Then probe this often. */
  everyMs: number;
  /** Give up this long after the write, as the waited path does (factsSyncTimeout 5). */
  deadlineMs: number;
}

export const SYNC_TIMING: SyncTiming = { firstMs: 450, everyMs: 100, deadlineMs: 5_000 };

/** The PDP did not show a write before the deadline. The routes answer it as the waited path's 424. */
export class PdpSyncTimeout extends Error {
  readonly status = 424;
}

/** The PDP answered without a debug block, so its data cannot be read. */
export class PdpSyncUnavailable extends Error {}

/**
 * Confirms a write sent straight to Permit's control plane by reading it back from the local PDP. Each probe is a
 * check of {@link SYNC_ACTION}; with the PDP's debug mode on, its answer carries the request as the PDP evaluated
 * it: the user's attributes and roles in the probed tenant, and the resource's attributes. This is the "normal
 * path": in our measurements, about 0.75 s from write to PDP, against 0.9 to 1.7 s for a waited write.
 * A role on a single resource is read from the PDP's user-permissions answer instead ({@link untilInstanceRole}).
 */
export class PdpSync {
  private readonly url: string;
  private readonly userPermissionsUrl: string;

  constructor(
    pdpUrl: string,
    private readonly apiKey: string,
    private readonly timing: SyncTiming = SYNC_TIMING,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {
    const base = pdpUrl.replace(/\/+$/, '');
    this.url = `${base}/allowed`;
    this.userPermissionsUrl = `${base}/user-permissions`;
  }

  /** One probe. Undefined when the PDP could not be asked or did not answer 200; throws when it has no debug block. */
  async view(user: string, resource: IResource): Promise<PdpView | undefined> {
    let res: Response;
    try {
      // Not the SDK: the PDP's own POST /allowed, because only its debug block shows what the PDP holds.
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ user: { key: user }, action: SYNC_ACTION, resource, context: {} }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    const request = record(record(body)['debug'])['request'];
    if (request === undefined) {
      throw new PdpSyncUnavailable('The PDP answered without a debug block, so the portal cannot confirm writes. Start it with PDP_DEBUG=True, or set PERMIT_WRITES=waited.');
    }
    return { user: record(record(record(request)['user'])['attributes']), resource: record(record(record(request)['resource'])['attributes']) };
  }

  /** Polls until `ready` holds for the PDP's view, from `firstMs` after the call, every `everyMs`, up to `deadlineMs`. */
  until(user: string, resource: IResource, ready: (view: PdpView) => boolean): Promise<void> {
    return this.poll(() => this.view(user, resource), ready);
  }

  /**
   * The roles the PDP lists for `user` on one resource instance (`type:key`), derived ones included, read from its
   * user-permissions answer: empty when the answer has no entry for it. Undefined when the PDP could not be asked, did
   * not answer 200 or answered something other than a permission map: a failed read is never an empty one.
   */
  async instanceRoles(user: string, tenant: string, resourceInstance: string): Promise<string[] | undefined> {
    let res: Response;
    try {
      // Not the SDK: the PDP's own POST /user-permissions, the call behind permit.getUserPermissions, with the
      // probe's timeout. The answer is keyed `type:key` and lists the user's roles on each resource.
      res = await fetch(this.userPermissionsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ user: { key: user }, tenants: [tenant], resources: [resourceInstance] }),
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }
    const permissions = permissionMap(body);
    if (permissions === undefined) return undefined;
    const roles = permissions[resourceInstance]?.roles;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
  }

  /**
   * Polls, with the same timing as {@link until}, until the PDP lists `role` for `user` on `resourceInstance`
   * (`present`) or no longer lists it. A check cannot confirm these writes: when two roles grant the same
   * action, as in S5's view-only swap, the check never changes. A role the user also derives on that resource through
   * a relation stays listed after its removal; the portal assigns none that way.
   */
  untilInstanceRole(user: string, tenant: string, resourceInstance: string, role: string, present: boolean): Promise<void> {
    return this.poll(() => this.instanceRoles(user, tenant, resourceInstance), (roles) => roles.includes(role) === present);
  }

  /** Reads from `firstMs` after the call, every `everyMs`, until a read holds `ready`; undefined reads never do. */
  private async poll<T>(read: () => Promise<T | undefined>, ready: (value: T) => boolean): Promise<void> {
    const start = this.now();
    await this.sleep(this.timing.firstMs);
    for (;;) {
      const value = await read();
      if (value !== undefined && ready(value)) return;
      if (this.now() - start + this.timing.everyMs > this.timing.deadlineMs) {
        throw new PdpSyncTimeout(`The PDP did not show the change within ${this.timing.deadlineMs / 1000} seconds.`);
      }
      await this.sleep(this.timing.everyMs);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A user-permissions answer as a map of entries, each with its `permissions` list, as the SDK reads it: the map itself,
 * or wrapped in OPA's `result.permissions`. Undefined for anything else.
 */
function permissionMap(body: unknown): Record<string, { roles?: unknown }> | undefined {
  const read = (value: unknown) =>
    isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && Array.isArray(entry['permissions']))
      ? (value as Record<string, { roles?: unknown }>)
      : undefined;
  return read(body) ?? (isRecord(body) && isRecord(body['result']) ? read(body['result']['permissions']) : undefined);
}

/** JSON with object keys sorted, so the PDP's key order does not matter when comparing values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Whether `held` has every key of `written` with the same value. Other keys (`roles`, `tenants`, `id`) are ignored. */
export function holds(held: Record<string, unknown>, written: object): boolean {
  return Object.entries(written).every(([key, value]) => canonical(held[key]) === canonical(value));
}

/** The user's roles in the probed tenant, as the PDP lists them. */
export function rolesIn(view: PdpView): string[] {
  const roles = view.user['roles'];
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}
