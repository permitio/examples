import { redirect } from 'next/navigation';
import { SignUpForm } from '@/components/auth/SignUpForm';
import { currentUser } from '@/lib/session';

export default async function SignUpPage() {
  if ((await currentUser()) !== null) redirect('/plan');
  return <SignUpForm />;
}
