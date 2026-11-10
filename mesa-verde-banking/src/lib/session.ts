import { getAuth } from '@/lib/auth';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** The signed-in user of a request, from its Better Auth session cookie, or null. */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers });
  if (session === null) return null;
  const { id, email, name } = session.user;
  return { id, email, name };
}
