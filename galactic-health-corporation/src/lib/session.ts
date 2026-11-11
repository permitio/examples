import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getAuth, type SessionUser } from '@/lib/auth';

/** The signed-in member of the current page request, looked up once per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  // Reading the headers first makes every page dynamic, so `next build` never opens the database.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session?.user ?? null;
});

/** The signed-in member, or a redirect to the sign-in page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) redirect('/sign-in');
  return user;
}
