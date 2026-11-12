import { getAuth, migrateDatabase } from '@/lib/auth';

/** Creates Better Auth's tables in the test file's in-memory database. */
export async function prepareDatabase(): Promise<void> {
  await migrateDatabase();
}

/**
 * Signs a new user up through Better Auth and returns the Cookie header of their session, as a
 * browser would send it.
 */
export async function signedIn(email: string, name = 'Test User'): Promise<string> {
  const { headers } = await getAuth().api.signUpEmail({
    body: { email, name, password: 'test-password-1' },
    returnHeaders: true,
  });
  const setCookie = headers.get('set-cookie');
  if (setCookie === null) throw new Error('Better Auth did not set a session cookie');
  const session = setCookie.split(';')[0];
  if (session === undefined) throw new Error('The session cookie is empty');
  return session;
}

/** A request to an app route, from the user with this session cookie (or no one). */
export function appRequest(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
}
