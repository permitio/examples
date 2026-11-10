'use client';

import {
  Alert,
  Button,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import { Brand } from '@/components/auth/Brand';
import { authClient } from '@/lib/auth-client';
import { DEMO_PASSWORD, PERSONAS } from '@/lib/personas';

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? 'Could not sign in.');
        return;
      }
      router.replace('/plan');
      router.refresh();
    });
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Paper className="w-full max-w-md p-6">
        <Brand />
        <form onSubmit={signIn} className="mt-4 flex flex-col gap-4">
          <Typography variant="h6" component="h2">
            Sign in
          </Typography>
          {error === '' ? null : <Alert severity="error">{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <Button type="submit" variant="contained" disabled={pending}>
            Sign in
          </Button>
          <Typography variant="body2">
            New here?{' '}
            <Link href="/sign-up" className="text-sky-600">
              Create an account
            </Link>
          </Typography>
        </form>
        <Typography variant="subtitle2" component="h3" className="mt-6">
          Demo members (password {DEMO_PASSWORD})
        </Typography>
        <List dense>
          {PERSONAS.map((persona) => (
            <ListItem key={persona.id} disablePadding>
              <ListItemButton
                onClick={() => {
                  setEmail(persona.email);
                  setPassword(DEMO_PASSWORD);
                }}
              >
                <ListItemText
                  primary={`${persona.firstName} ${persona.lastName} (${persona.email})`}
                  secondary={persona.role}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Paper>
    </div>
  );
}
