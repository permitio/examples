// The request plumbing every router of these systems shares: one error to refuse a request with, the body readers, and the
// one error handler that answers them all. app.ts puts the handler last; a test that mounts a router alone adds it too.
import type { ErrorRequestHandler, Request } from 'express';
import { TransitionError } from '#src/requests';

/** A request these systems refuse: the error handler answers `status` and `{ error: message }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Body = Record<string, unknown>;

/** The JSON object body. A field outside `allowed` is a 400, never silently dropped: a misspelt field must not vanish. */
export function jsonBody(req: Request, allowed: readonly string[]): Body {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object body');
  const unknown = Object.keys(body).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) throw new HttpError(400, `Unknown field: ${unknown.join(', ')}`);
  return body as Body;
}

/**
 * A required, non-blank text field, trimmed, so the same input means the same thing in every router: 'frodo ' is Frodo.
 * With `max`, at most that many characters.
 */
export function text(body: Body, field: string, max?: number): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (max !== undefined && trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
}

/** A failure's message. Node's fetch says only "fetch failed" and keeps the useful part in `cause`. */
export function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

/** The HTTP status an SDK error carries (`PermitApiError.status`), if any. */
export function statusOf(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The one error handler: an HttpError answers its status and message, a move the request state machine forbids a 409, a
 * body express.json() could not read its own 4xx, and anything else a 500, logged with its route.
 */
export const answerErrors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof TransitionError) {
    res.status(409).json({ error: error.message });
    return;
  }
  // express.json() rejects a malformed or oversized body with a 4xx status of its own.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'Invalid request body' });
    return;
  }
  console.error(`great-eagle-systems: unexpected error on ${req.method} ${req.path}`, error);
  res.status(500).json({ error: 'Unexpected error' });
};
