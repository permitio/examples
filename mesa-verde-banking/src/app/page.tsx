import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { currentUser } from '@/lib/current-user';

export default async function SignInPage() {
  if ((await currentUser()) !== null) redirect('/account');
  return <AuthForm />;
}
