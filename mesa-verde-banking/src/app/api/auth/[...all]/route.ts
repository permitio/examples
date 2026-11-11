import { getAuth } from '@/lib/auth';

// Better Auth's endpoints: sign-up, sign-in, sign-out and the session. The auth instance is
// created on the first request, so `next build` does not open the database.
export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return getAuth().handler(request);
}
