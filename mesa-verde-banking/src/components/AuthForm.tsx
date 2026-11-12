'use client';

import { Alert, Button, Card, Form, Input, List, Tabs } from 'antd';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { authClient } from '@/lib/auth-client';
import { DEMO_PASSWORD, PERSONAS } from '@/lib/personas';

interface SignInValues {
  email: string;
  password: string;
}

interface SignUpValues extends SignInValues {
  name: string;
}

type Mode = 'sign-in' | 'sign-up';

/** Email and password sign-in and sign-up with Better Auth, and the list of demo users. */
export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('sign-in');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [signInForm] = Form.useForm<SignInValues>();

  const finish = (result: { error: { message?: string | undefined } | null }) => {
    if (result.error !== null) {
      setError(result.error.message ?? 'Something went wrong. Try again.');
      return;
    }
    router.replace('/account');
    router.refresh();
  };

  const signIn = (values: SignInValues) => {
    setError(null);
    startTransition(async () => finish(await authClient.signIn.email(values)));
  };

  const signUp = (values: SignUpValues) => {
    setError(null);
    startTransition(async () => finish(await authClient.signUp.email(values)));
  };

  const fillDemoUser = (email: string) => {
    setMode('sign-in');
    signInForm.setFieldsValue({ email, password: DEMO_PASSWORD });
  };

  return (
    <div className="flex flex-col gap-6">
      <Card title="Mesa Verde online banking">
        {error === null ? null : <Alert type="error" title={error} className="!mb-4" />}
        <Tabs
          activeKey={mode}
          onChange={(key) => setMode(key === 'sign-up' ? 'sign-up' : 'sign-in')}
          items={[
            {
              key: 'sign-in',
              label: 'Sign in',
              children: (
                <Form form={signInForm} layout="vertical" onFinish={signIn} disabled={pending}>
                  <Form.Item label="Email" name="email" rules={[{ required: true, type: 'email' }]}>
                    <Input autoComplete="username" />
                  </Form.Item>
                  <Form.Item label="Password" name="password" rules={[{ required: true }]}>
                    <Input.Password autoComplete="current-password" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={pending}>
                    Sign in
                  </Button>
                </Form>
              ),
            },
            {
              key: 'sign-up',
              label: 'Open an account',
              children: (
                <Form<SignUpValues> layout="vertical" onFinish={signUp} disabled={pending}>
                  <Form.Item label="Full name" name="name" rules={[{ required: true }]}>
                    <Input autoComplete="name" />
                  </Form.Item>
                  <Form.Item label="Email" name="email" rules={[{ required: true, type: 'email' }]}>
                    <Input autoComplete="email" />
                  </Form.Item>
                  <Form.Item
                    label="Password"
                    name="password"
                    rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}
                  >
                    <Input.Password autoComplete="new-password" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={pending}>
                    Open an account
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Card>
      <Card title={`Demo users (password: ${DEMO_PASSWORD})`}>
        <List
          dataSource={[...PERSONAS]}
          renderItem={(persona) => (
            <List.Item
              actions={[
                <Button key="use" onClick={() => fillDemoUser(persona.email)}>
                  Use
                </Button>,
              ]}
            >
              <List.Item.Meta title={persona.email} description={persona.summary} />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}
