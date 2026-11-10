import { Permit } from 'permitio';
import { permitSettings } from '@/lib/config';

let client: Permit | undefined;

/**
 * The app's Permit client: checks go to the PDP, data changes go to Permit's API. The SDK's own
 * logger is off because every caller reports the errors it gets (see `describePermitError`).
 */
export function getPermit(): Permit {
  client ??= new Permit({ ...permitSettings(), log: { level: 'silent' } });
  return client;
}

interface ErrorWithResponse {
  response?: { status?: unknown; data?: unknown };
}

/** The HTTP status of a failed Permit API call, or undefined for other errors. */
export function permitStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const status = (error as ErrorWithResponse).response?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Permit's explanation of a failed API call, falling back to the error's own message. */
export function describePermitError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const data = (error as ErrorWithResponse).response?.data;
    if (typeof data === 'object' && data !== null && 'message' in data) {
      return String(data.message);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a Permit write whose target may already exist. A 409 means it does, so there is nothing to
 * do; any other error is rethrown.
 */
export async function ignoreConflict(write: () => Promise<unknown>): Promise<'done' | 'exists'> {
  try {
    await write();
    return 'done';
  } catch (error) {
    if (permitStatus(error) === 409) return 'exists';
    throw error;
  }
}

/** Runs a Permit delete whose target may already be gone. A 404 means it is. */
export async function ignoreNotFound(remove: () => Promise<unknown>): Promise<'done' | 'absent'> {
  try {
    await remove();
    return 'done';
  } catch (error) {
    if (permitStatus(error) === 404) return 'absent';
    throw error;
  }
}
