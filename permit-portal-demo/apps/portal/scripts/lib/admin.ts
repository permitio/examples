import { type Permit, PermitConnectionError, PermitContextError, PermitPDPStatusError } from 'permitio';
import { createPermit } from '#src/server/permit/client';
import { MissingEnvError, type ScriptEnv } from '#scripts/lib/env';
import type { AssignmentSpec, InstanceSpec, PermitData, TenantSpec, TupleSpec, UserSpec } from '#scripts/lib/fixtures';

/** A non-2xx answer from a service the scripts call over plain HTTP (the PDP, the mock, the portal). */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The Permit client for scripts. `proxyFacts: false` writes straight to the control plane (fast bulk seeding). */
export function scriptPermit(env: ScriptEnv, proxyFacts = false): Permit {
  return createPermit({ apiUrl: env.apiUrl, apiKey: env.apiKey, pdpUrl: env.pdpUrl, proxyFacts });
}

export function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  return typeof err.status === 'number' ? err.status : undefined;
}

function causeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'cause' in err ? err.cause : undefined;
}

function codeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}

/** One line for the operator. Keeps the API's own explanation (the SDK has already bounded and redacted it). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === 'string' ? err : json(err);
  const detail = (err as { response?: { data?: unknown } }).response?.data;
  const withDetail = detail === undefined || detail === null || detail === '' ? err.message : `${err.message} ${json(detail)}`;
  const cause = err.cause instanceof Error && !withDetail.includes(err.cause.message) ? ` (${err.cause.message})` : '';
  return withDetail + cause;
}

/**
 * Creates an object, or updates it when it already exists (409). Any other error is rethrown with the label
 * prefixed and the original as its cause.
 */
export async function upsert<T>(label: string, create: () => Promise<T>, update: () => Promise<unknown>): Promise<'created' | 'updated'> {
  try {
    await create();
    return 'created';
  } catch (err) {
    if (statusOf(err) !== 409) throw new Error(`${label}: ${describeError(err)}`, { cause: err });
  }
  try {
    await update();
    return 'updated';
  } catch (err) {
    throw new Error(`${label}: ${describeError(err)}`, { cause: err });
  }
}

/** Creates an object that has nothing to update; a 409 means it already exists. */
export async function ensure(label: string, create: () => Promise<unknown>): Promise<'created' | 'exists'> {
  return (await upsert(label, create, async () => undefined)) === 'created' ? 'created' : 'exists';
}

/**
 * Whether a tenant exists. Lists instead of reading it, because the SDK logs every failed request as an error, and
 * an expected 404 would print one on every clean preflight. The search matches keys by substring, hence the filter.
 */
export async function tenantExists(permit: Permit, key: string): Promise<boolean> {
  // Permit read: the tenants whose key contains this one (api.tenants.list), and this one among them.
  return (await permit.api.tenants.list({ search: key })).some((t) => t.key === key);
}

/** Runs `fn`, treating a 404 as "already gone". */
export async function ignoreNotFound(fn: () => Promise<unknown>): Promise<'done' | 'absent'> {
  try {
    await fn();
    return 'done';
  } catch (err) {
    if (statusOf(err) === 404) return 'absent';
    throw err;
  }
}

/** Plain HTTP to the PDP, the mock or the portal. Statuses in `accept` are answers, any other non-2xx throws. */
export async function httpRequest(method: 'GET' | 'POST', url: string, opts: { headers?: Record<string, string>; accept?: number[] } = {}):
  Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method, headers: opts.headers ?? {} });
  const text = await res.text();
  if (!res.ok && !opts.accept?.includes(res.status)) throw new HttpError(`${method} ${url} answered ${res.status}`, res.status);
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body };
}

export type Log = (line: string) => void;
/** Runs one write and logs its result: `  created  tenant preflight`. */
export async function logged(log: Log, label: string, op: () => Promise<string>): Promise<void> {
  log(`  ${(await op()).padEnd(8)} ${label}`);
}

/** Permit write: api.tenants.create, or update when the tenant exists. */
export function upsertTenant(permit: Permit, t: TenantSpec): Promise<'created' | 'updated'> {
  return upsert(`tenant ${t.key}`, () => permit.api.tenants.create(t), () => permit.api.tenants.update(t.key, { name: t.name }));
}

/** Permit write: api.resourceInstances.create, or update when the instance exists. */
export function upsertInstance(permit: Permit, i: InstanceSpec): Promise<'created' | 'updated'> {
  return upsert(`instance ${i.resource}:${i.key}`, () => permit.api.resourceInstances.create(i),
    () => permit.api.resourceInstances.update(`${i.resource}:${i.key}`, { attributes: i.attributes }));
}

/** Permit write: api.relationshipTuples.create links two instances: ean:EAN-1001 is the parent of shipment:SHP-77001. */
export function ensureTuple(permit: Permit, t: TupleSpec): Promise<'created' | 'exists'> {
  return ensure(`tuple ${t.subject} ${t.relation} ${t.object}`, () => permit.api.relationshipTuples.create(t));
}

/** Permit write: api.users.sync writes the user with the whole attribute set (Permit replaces it on every write). */
export async function syncUser(permit: Permit, u: UserSpec): Promise<'created' | 'updated'> {
  const { tenant, ...user } = u;
  if (tenant !== undefined) return syncTenantUser(permit, tenant, user);
  const { created } = await permit.api.users.sync(user);
  return created ? 'created' : 'updated';
}

/**
 * A user who belongs to `tenant` without a role. Permit only creates such a user inside the tenant
 * (tenants.addUser) and cannot move an existing one there, so a user found outside it is deleted and created again.
 * One already in it is patched, not replaced, so the membership stays.
 */
async function syncTenantUser(permit: Permit, tenant: string, user: Omit<UserSpec, 'tenant'>): Promise<'created' | 'updated'> {
  let existing: Awaited<ReturnType<Permit['api']['users']['get']>> | undefined;
  try {
    // Permit read: the user, if Permit has one with this key (api.users.get).
    existing = await permit.api.users.get(user.key);
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
  if (existing && (existing.associated_tenants ?? []).some((t) => t.tenant === tenant)) {
    // Permit write: the user patched in place (api.users.update), so the membership stays.
    await permit.api.users.update(user.key, { first_name: user.first_name, last_name: user.last_name, attributes: user.attributes });
    return 'updated';
  }
  // Permit write: a user found outside the tenant is deleted (api.users.delete) and created inside it (api.tenants.addUser).
  if (existing) await permit.api.users.delete(user.key);
  await permit.api.tenants.addUser(tenant, user);
  return 'created';
}

/** Permit write: api.users.assignRole gives a role in a tenant, or on one instance (Frodo's account_admin on ean:EAN-1001). */
export function ensureAssignment(permit: Permit, a: AssignmentSpec): Promise<'created' | 'exists'> {
  const on = a.resource_instance ?? a.tenant;
  return ensure(`role ${a.role} for ${a.user} on ${on}`, () => permit.api.users.assignRole(a));
}

/** Creates or updates tenants, then instances, tuples, users and role assignments, logging one line per object. */
export async function writeData(permit: Permit, data: PermitData, log: Log): Promise<void> {
  for (const t of data.tenants) await logged(log, `tenant ${t.key}`, () => upsertTenant(permit, t));
  for (const i of data.instances) await logged(log, `instance ${i.resource}:${i.key} @${i.tenant}`, () => upsertInstance(permit, i));
  for (const t of data.tuples) await logged(log, `tuple ${t.subject} ${t.relation} ${t.object}`, () => ensureTuple(permit, t));
  for (const u of data.users) await logged(log, `user ${u.key}`, () => syncUser(permit, u));
  for (const a of data.assignments) {
    await logged(log, `role ${a.role} for ${a.user} on ${a.resource_instance ?? a.tenant}`, () => ensureAssignment(permit, a));
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH',
  'ERR_NETWORK', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const environmentStatus = (status: number | undefined) => status === 401 || status === 403 || (status !== undefined && status >= 500);

/**
 * True when an error means the script could not run (exit 2): a missing setting, an unreachable or unhealthy
 * service, or a rejected API key. Anything else is a failure (exit 1). Walks the cause chain, so labelled errors
 * keep their meaning.
 */
export function couldNotRun(err: unknown): boolean {
  let e = err;
  for (let depth = 0; e !== undefined && e !== null && depth < 8; depth++, e = causeOf(e)) {
    if (e instanceof MissingEnvError || e instanceof PermitContextError) return true;
    // A PDP status error is a PermitConnectionError too, but a 4xx other than 401/403 means our input was wrong.
    if (e instanceof PermitPDPStatusError) return e.statusCode === undefined || environmentStatus(e.statusCode);
    if (e instanceof PermitConnectionError) return true;
    if (e instanceof TypeError && e.message === 'fetch failed') return true;
    if (environmentStatus(statusOf(e))) return true;
    const code = codeOf(e);
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  }
  return false;
}
