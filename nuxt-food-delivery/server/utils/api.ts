import { createError, getHeader, type H3Event } from 'h3';
import { PermitApiError, type IResource } from 'permitio';
import { isCity, type City } from '#shared/types';
import { permit } from '#server/utils/permit';
import { parseUserKey } from '#server/utils/validate';

/**
 * Who is asking, and in which city. The app has no sign-in: the user switcher in the sidebar sends
 * the current user and city as the `user` and `city` headers. In production, take the user from
 * your session instead.
 */
export interface Caller {
  user: string;
  tenant: City;
}

export function callerOf(event: H3Event): Caller {
  const user = parseUserKey(getHeader(event, 'user'));
  const city = getHeader(event, 'city');
  if (!isCity(city)) throw createError({ statusCode: 400, message: `Unknown city: ${city ?? ''}` });
  return { user, tenant: city };
}

/** A resource in the caller's city. */
export type CityResource = Omit<IResource, 'tenant'>;

/** The HTTP status of a failed Permit API call, when Permit answered. */
export function permitStatus(error: unknown): number | undefined {
  return error instanceof PermitApiError ? error.response?.status : undefined;
}

/** Logs a failed call to Permit and turns it into a 502 that names the operation. */
function permitFailure(operation: string, error: unknown): Error {
  const status = permitStatus(error);
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`Permit could not ${operation}: ${reason}`);
  const answered = status === undefined ? '' : ` (Permit answered ${status})`;
  return createError({ statusCode: 502, message: `Permit could not ${operation}${answered}.` });
}

/** Asks Permit (the PDP) whether the caller may do `action` on `resource` in their city. */
export async function isAllowed(
  caller: Caller,
  action: string,
  resource: CityResource,
): Promise<boolean> {
  try {
    return await permit().check(caller.user, action, { ...resource, tenant: caller.tenant });
  } catch (error) {
    throw permitFailure(`check ${action} on ${resource.type}`, error);
  }
}

/** Like {@link isAllowed}, but answers a deny with a 403. */
export async function authorize(
  caller: Caller,
  action: string,
  resource: CityResource,
): Promise<void> {
  if (!(await isAllowed(caller, action, resource))) {
    throw createError({ statusCode: 403, message: 'You are not permitted to perform this action' });
  }
}

/** Runs a write to Permit's API; a failure becomes a 502 that names the operation. */
export async function permitWrite<T>(operation: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw permitFailure(operation, error);
  }
}

/**
 * Runs a Permit write that may already be done: `doneStatus` is the answer that means so, 409
 * ("already exists") for a create or an assign, 404 ("not found") for a delete or an unassign.
 */
export async function permitWriteOnce(
  operation: string,
  write: () => Promise<unknown>,
  doneStatus: 404 | 409,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (permitStatus(error) !== doneStatus) throw permitFailure(operation, error);
  }
}

/**
 * Removes resource instances for records the app dropped. The records are already gone, so a
 * failure is logged rather than failing the request that dropped them.
 */
export async function dropInstances(resource: 'Meal' | 'Order', keys: string[]): Promise<void> {
  const results = await Promise.allSettled(
    // Permit write: deletes the instance (and its instance role assignments) from Permit.
    keys.map((key) => permit().api.resourceInstances.delete(`${resource}:${key}`)),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected' && permitStatus(result.reason) !== 404) {
      const reason = result.reason instanceof Error ? result.reason.message : result.reason;
      console.error(`Permit could not delete ${resource}:${keys[index]}: ${String(reason)}`);
    }
  });
}
