import type { NextApiHandler, NextApiRequest } from 'next';
import { PermitApiError, PermitConnectionError } from 'permitio';
import type { ApiError } from '#lib/model';

const METHODS = ['GET', 'POST', 'DELETE'] as const;
type Method = (typeof METHODS)[number];

/** The header the persona switcher sets. It stands in for a signed-in user's identity. */
const PERSONA_HEADER = 'x-user';

export type Reply<T> =
  | { status: 200; body: T }
  | { status: 400 | 401 | 403 | 404 | 405 | 409 | 500 | 502 | 503; body: ApiError };

export interface RouteInput {
  /** The persona making the request. */
  actor: string;
  query: NextApiRequest['query'];
}

type Action<T> = (input: RouteInput) => Promise<Reply<T>>;

export const ok = <T>(body: T): Reply<T> => ({ status: 200, body });

export const fail = <T>(status: Exclude<Reply<T>['status'], 200>, error: string): Reply<T> => ({
  status,
  body: { error },
});

/** One dynamic segment of the route, or `undefined` when it is missing or repeated. */
export function segment(query: NextApiRequest['query'], name: string): string | undefined {
  const value = query[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isMethod(value: string | undefined): value is Method {
  return METHODS.some((method) => method === value);
}

/**
 * Turns an SDK error into a reply that says which part of Permit failed: a 404 or 409 from the REST
 * API passes through, any other API error is a 502, and a failed PDP call is a 503. The SDK's
 * `check()` reports every PDP failure, an error answer or no answer, as `PermitConnectionError`.
 */
function replyForError<T>(error: unknown): Reply<T> {
  if (error instanceof PermitApiError) {
    const status: unknown = error.response?.status;
    const detail = `Permit API: ${error.message}`;
    if (status === 404) return fail(404, detail);
    if (status === 409) return fail(409, detail);
    return fail(502, detail);
  }
  if (error instanceof PermitConnectionError) {
    return fail(503, `The PDP call failed: ${error.message}`);
  }
  return fail(500, 'Internal error; the server log has the details');
}

/**
 * Builds a Pages Router API handler from one action per HTTP method. Each action gets the persona
 * from the `X-User` header; a request without one gets 401, and an unlisted method gets 405.
 */
export function apiRoute<T>(
  actions: Partial<Record<Method, Action<T>>>,
): NextApiHandler<T | ApiError> {
  const allowed = METHODS.filter((method) => actions[method] !== undefined);
  return async (req, res) => {
    const action = isMethod(req.method) ? actions[req.method] : undefined;
    if (action === undefined) {
      res.setHeader('Allow', allowed.join(', '));
      res.status(405).json({ error: `Method ${req.method ?? ''} is not allowed` });
      return;
    }
    const actor = req.headers[PERSONA_HEADER];
    if (typeof actor !== 'string' || actor === '') {
      res.status(401).json({ error: 'Pick a persona: the X-User header is missing' });
      return;
    }
    let reply: Reply<T>;
    try {
      reply = await action({ actor, query: req.query });
    } catch (error) {
      console.error(`${req.method} ${req.url ?? ''} failed:`, error);
      reply = replyForError(error);
    }
    res.status(reply.status).json(reply.body);
  };
}
