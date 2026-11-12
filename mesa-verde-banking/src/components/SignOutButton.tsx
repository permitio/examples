'use client';

import { Button } from 'antd';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { authClient } from '@/lib/auth-client';

/** Ends the Better Auth session and, if one was opened, the Permit Elements session. */
export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const signOut = () => {
    startTransition(async () => {
      const { default: permit } = await import('@permitio/permit-js');
      await Promise.allSettled([permit.elements.logout(), authClient.signOut()]);
      router.replace('/');
      router.refresh();
    });
  };

  return (
    <Button type="primary" onClick={signOut} loading={pending}>
      Log out
    </Button>
  );
}
