import { setTimeout as delay } from 'node:timers/promises';
import type { IResource, IUser, Permit } from 'permitio';
import { HttpError } from '#scripts/lib/admin';
import type { ScriptEnv } from '#scripts/lib/env';

export type Attributes = Record<string, unknown>;

/** One authorization question: who, what, and on which resource instance. */
export interface CheckSpec {
  user: string;
  action: string;
  type: string;
  key: string;
  tenant: string;
  extra?: Attributes | undefined;
}

/** Every check sends the time as a user attribute, never in `context`. */
export function checkUser(key: string, now = Date.now()): IUser {
  return { key, attributes: { current_time: now } };
}

/** Every check sends the resource key as the `id` attribute, since rules cannot read the key itself. */
export function checkResource(
  type: string,
  key: string,
  tenant: string,
  extra: Attributes = {},
): IResource {
  return { type, key, tenant, attributes: { ...extra, id: key } };
}

/**
 * Permit check: may this user do this action on this resource? permit.check, as the portal sends it
 * (preflight's policy matrix).
 */
export function decide(permit: Permit, c: CheckSpec, now = Date.now()): Promise<boolean> {
  return permit.check(
    checkUser(c.user, now),
    c.action,
    checkResource(c.type, c.key, c.tenant, c.extra),
  );
}

export function describeCheck(c: CheckSpec): string {
  const extra = c.extra && Object.keys(c.extra).length > 0 ? ` ${JSON.stringify(c.extra)}` : '';
  return `${c.user} ${c.action} ${c.type}:${c.key}@${c.tenant}${extra}`;
}

/** The PDP's own health endpoint. Returns the HTTP status; a network failure throws. */
export async function pdpHealthStatus(pdpUrl: string): Promise<number> {
  const res = await fetch(`${pdpUrl}/healthy`);
  return res.status;
}

/**
 * What the PDP's POST /allowed returns. With PDP_DEBUG on, `debug` holds Permit's code and reason
 * per model.
 */
export interface AllowedResponse {
  allow?: boolean;
  debug?: Record<string, unknown> | null;
}

/** Sends the same input as permit.check straight to the PDP, to read the debug block the SDK drops. */
export async function explain(
  env: Pick<ScriptEnv, 'pdpUrl' | 'apiKey'>,
  c: CheckSpec,
  now = Date.now(),
): Promise<AllowedResponse> {
  const body = {
    user: checkUser(c.user, now),
    action: c.action,
    resource: checkResource(c.type, c.key, c.tenant, c.extra),
    context: {},
  };
  const res = await fetch(`${env.pdpUrl}/allowed`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(`PDP POST /allowed answered ${res.status}`, res.status);
  return (await res.json()) as AllowedResponse;
}

/** Calls `probe` until `done` holds or the deadline passes. A bounded poll, never a fixed sleep. */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ ok: boolean; value: T; elapsedMs: number }> {
  const start = performance.now();
  for (;;) {
    const value = await probe();
    const elapsedMs = performance.now() - start;
    if (done(value)) return { ok: true, value, elapsedMs };
    if (elapsedMs >= opts.timeoutMs) return { ok: false, value, elapsedMs };
    await delay(Math.min(opts.intervalMs, opts.timeoutMs - elapsedMs));
  }
}
