import { z } from 'zod';
import { KEY_PATTERN } from '@/lib/accounts';

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function unauthorized(): Response {
  return json({ error: 'Sign in first' }, 401);
}

export function forbidden(body: Record<string, unknown> = { error: 'Forbidden' }): Response {
  return json(body, 403);
}

export function badRequest(error: string): Response {
  return json({ error }, 400);
}

/** An error's message, without the request or response objects some errors carry. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Logs a failed call to Permit and answers 502: the app is fine, Permit did not answer. */
export function permitFailed(route: string, error: unknown): Response {
  console.error(`[${route}] Permit request failed: ${describeError(error)}`);
  return json({ error: 'Permit request failed' }, 502);
}

export const keySchema = z.string().min(1).max(255).regex(KEY_PATTERN);

/** The `tenant` query parameter, when it is a valid account key. */
export function tenantParam(request: Request): string | undefined {
  const parsed = keySchema.safeParse(new URL(request.url).searchParams.get('tenant'));
  return parsed.success ? parsed.data : undefined;
}

/** The request's JSON body, or undefined when it is not JSON. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}
