import { headers } from 'next/headers';
import { cache } from 'react';
import { getSessionUser, type SessionUser } from '@/lib/session';

/** The signed-in user of the page being rendered, read once per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  return getSessionUser(await headers());
});
