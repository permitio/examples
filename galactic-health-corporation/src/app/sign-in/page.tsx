import { redirect } from 'next/navigation';
import { SignInForm } from '@/components/auth/SignInForm';
import { currentUser } from '@/lib/session';

export default async function SignInPage() {
  if ((await currentUser()) !== null) redirect('/plan');
  return <SignInForm />;
}
