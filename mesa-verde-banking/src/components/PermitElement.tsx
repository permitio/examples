'use client';

import { Alert, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useAccount } from '@/components/AccountContext';
import { elementUrl, type ElementKey } from '@/lib/elements';

type LoginState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; error: string };

function loginError(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : 'Permit Elements login failed';
}

/**
 * One Permit Element in an iframe. It first logs the user into Elements for the account, with
 * permit-js's cookie login through the app's elements-login route, so the element acts as that user
 * in that tenant. permit-js is loaded only when an element opens.
 */
export function PermitElement({
  element,
  tenant,
  title,
  options = {},
}: {
  element: ElementKey;
  tenant: string;
  title: string;
  options?: Readonly<Record<string, string>>;
}) {
  const { elements } = useAccount();
  const [login, setLogin] = useState<{ key: string; state: LoginState } | null>(null);
  const loginKey = `${tenant}#${elements?.apiUrl ?? ''}`;

  useEffect(() => {
    if (elements === null) return undefined;
    let cancelled = false;
    const settle = (state: LoginState) => {
      if (!cancelled) setLogin({ key: loginKey, state });
    };
    import('@permitio/permit-js')
      .then(async ({ default: permit, LoginMethod }) => {
        // A session for another account would stay connected, so end it first.
        await permit.elements.logout();
        await permit.elements.login({
          loginUrl: '/account/api/elements-login',
          loginMethod: LoginMethod.cookie,
          tenant,
          permitApiUrl: elements.apiUrl,
        });
      })
      .then(
        () => settle({ status: 'ready' }),
        (error: unknown) => settle({ status: 'failed', error: loginError(error) }),
      );
    return () => {
      cancelled = true;
    };
  }, [elements, tenant, loginKey]);

  if (elements === null) {
    return (
      <Alert
        type="warning"
        title="Permit Elements are not available"
        description="The app could not read the environment id from Permit. The rest of the app works without them."
      />
    );
  }
  const state: LoginState = login?.key === loginKey ? login.state : { status: 'loading' };
  if (state.status === 'loading') return <Spin />;
  if (state.status === 'failed') {
    return <Alert type="error" title="Permit Elements did not load" description={state.error} />;
  }
  return (
    <iframe
      title={title}
      src={elementUrl(elements.embedUrl, element, elements.envId, options)}
      className="h-full w-full border-0"
    />
  );
}
