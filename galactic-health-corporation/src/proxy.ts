import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Sends visitors without a session cookie to the sign-in page. This is only a fast first check: the
 * member pages and every API route validate the session themselves.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request) !== null) return NextResponse.next();
  return NextResponse.redirect(new URL('/sign-in', request.url));
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico|sign-in|sign-up).*)'],
};
