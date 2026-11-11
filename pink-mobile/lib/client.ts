/**
 * The browser side of the API routes. Every call carries the persona in the `X-User` header, which
 * stands in for a signed-in user in this example.
 */

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

function errorOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  return typeof body.error === 'string' ? body.error : undefined;
}

/** The parsed JSON body, or `undefined` for a body that is not JSON, such as an HTML error page. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Calls an API route as `persona`. The routes answer `{ error }` on failure, and the error is
 * returned rather than thrown so each tab can show why Permit said no.
 */
export async function callApi<T>(
  path: string,
  persona: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
): Promise<Outcome<T>> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, { method, headers: { 'X-User': persona } });
    text = await response.text();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const body = parse(text);
  if (!response.ok) {
    return { ok: false, error: errorOf(body) ?? `The request failed with ${response.status}` };
  }
  if (body === undefined) {
    return { ok: false, error: `${path} did not answer with JSON` };
  }
  // The routes in pages/api build this body from the same types, see lib/model.ts.
  return { ok: true, data: body as T };
}

/** Builds a route path from segments, encoding each one. */
export const apiPath = (...segments: string[]) =>
  `/api/${segments.map((part) => encodeURIComponent(part)).join('/')}`;
