import type { ReactNode } from 'react';
import { requireUser } from '@/lib/session';

/** The member pages need a valid session; without one they redirect to the sign-in page. */
export default async function MemberLayout({ children }: { children: ReactNode }) {
  await requireUser();
  return children;
}
