import { type NextRequest, NextResponse } from 'next/server';
import { PermitConnectionError, PermitPDPStatusError } from 'permitio';
import { getAuth, type SessionUser } from '@/lib/auth';
import { ConfigError } from '@/lib/config';
import { describePermitError, permitStatus } from '@/lib/permit';

/** An error the route answers with as is: its status and message go to the client. */
export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status });
}

/** The 403 every route sends when Permit denies the signed-in member. */
export function denied(message = 'Not allowed.'): Response {
  return json({ error: message }, 403);
}

/** A 404 for extra path segments on a catch-all route whose handler takes none. */
export function rejectSegments(segments: string[] | undefined): void {
  if (segments !== undefined && segments.length > 0) throw new HttpError(404, 'Not found.');
}

/** The request's JSON body as a record, or a 400 when it is not a JSON object. */
export async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'Send a JSON body.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'Send a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** A required, non-empty string field of a request body. */
export function requireText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function errorResponse(request: NextRequest, error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const where = `${request.method} ${request.nextUrl.pathname}`;
  if (error instanceof ConfigError) {
    console.error(`${where}: ${error.message}`);
    return json({ error: error.message }, 500);
  }
  if (error instanceof PermitConnectionError) {
    console.error(`${where}: the PDP is unreachable: ${error.message}`);
    return json({ error: 'The Permit PDP is not reachable. Is its container running?' }, 503);
  }
  if (error instanceof PermitPDPStatusError || permitStatus(error) !== undefined) {
    const detail = describePermitError(error);
    console.error(`${where}: Permit answered ${permitStatus(error) ?? 'an error'}: ${detail}`);
    return json({ error: 'Permit could not complete the request.', detail }, 502);
  }
  console.error(`${where} failed:`, error);
  return json({ error: 'Unexpected error.' }, 500);
}

interface Context<Params> {
  user: SessionUser;
  params: Params;
}

/**
 * Wraps a route handler for signed-in members: answers 401 without a session, and turns errors into
 * JSON responses (`HttpError` as is, Permit and PDP failures as 502 or 503).
 */
export function memberRoute<Params = Record<string, never>>(
  handler: (request: NextRequest, context: Context<Params>) => Promise<Response>,
) {
  return async (request: NextRequest, route: { params: Promise<Params> }): Promise<Response> => {
    try {
      const session = await getAuth().api.getSession({ headers: request.headers });
      if (session === null) return json({ error: 'Sign in first.' }, 401);
      return await handler(request, { user: session.user, params: await route.params });
    } catch (error) {
      return errorResponse(request, error);
    }
  };
}
