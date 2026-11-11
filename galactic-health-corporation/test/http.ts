/** Helpers to call the route handlers the way Next.js does, with a real Better Auth session. */
import { NextRequest } from 'next/server';
import { getAuth, migrateAuthDatabase } from '@/lib/auth';

export interface Member {
  id: string;
  email: string;
  cookie: string;
}

let counter = 0;

/** Creates the tables of this test file's in-memory database. */
export function setUpDatabase(): Promise<void> {
  return migrateAuthDatabase();
}

/** Signs up a new member through Better Auth and returns their id and session cookie. */
export async function signUp(firstName = 'Test'): Promise<Member> {
  counter += 1;
  const email = `${firstName.toLowerCase()}-${counter}@example.com`;
  const { headers, response } = await getAuth().api.signUpEmail({
    body: {
      email,
      password: 'test-password',
      name: `${firstName} Tester`,
      firstName,
      lastName: 'Tester',
      phoneNumber: '(555) 000-0000',
      dateOfBirth: '1990-01-01',
    },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  return { id: response.user.id, email, cookie };
}

/** A request to the app, signed in when `cookie` is given. */
export function request(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown } = {},
): NextRequest {
  const headers = new Headers();
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
}

/** The second argument Next.js passes to a route handler. */
export function params<P>(value: P): { params: Promise<P> } {
  return { params: Promise.resolve(value) };
}

/** The JSON body of a response. */
export async function body<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
