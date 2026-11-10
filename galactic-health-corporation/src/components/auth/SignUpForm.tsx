'use client';

import { Alert, Button, Paper, TextField, Typography } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs, { type Dayjs } from 'dayjs';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState, useTransition } from 'react';
import { Brand } from '@/components/auth/Brand';
import { authClient } from '@/lib/auth-client';

interface Fields {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phoneNumber: string;
}

const EMPTY: Fields = { firstName: '', lastName: '', email: '', password: '', phoneNumber: '' };

/**
 * Sign-up asks for the profile the dashboard shows. Creating the account also registers the member
 * in Permit as the owner of their own data (see `src/lib/auth.ts`).
 */
export function SignUpForm() {
  const router = useRouter();
  const [fields, setFields] = useState(EMPTY);
  const [dateOfBirth, setDateOfBirth] = useState<Dayjs | null>(() => dayjs().subtract(18, 'year'));
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const field = (name: keyof Fields) => ({
    name,
    value: fields[name],
    onChange: (event: { target: { value: string } }) =>
      setFields((previous) => ({ ...previous, [name]: event.target.value })),
    required: true,
  });

  const signUp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (dateOfBirth === null || !dateOfBirth.isValid()) {
      setError('Enter your date of birth.');
      return;
    }
    startTransition(async () => {
      const result = await authClient.signUp.email({
        ...fields,
        name: `${fields.firstName} ${fields.lastName}`,
        dateOfBirth: dateOfBirth.format('YYYY-MM-DD'),
      });
      if (result.error) {
        setError(result.error.message ?? 'Could not create your account.');
        return;
      }
      router.replace('/plan');
      router.refresh();
    });
  };

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <Paper className="w-full max-w-lg p-6">
        <Brand />
        <form onSubmit={signUp} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Typography variant="h6" component="h2" className="sm:col-span-2">
            Create your account
          </Typography>
          {error === '' ? null : (
            <Alert severity="error" className="sm:col-span-2">
              {error}
            </Alert>
          )}
          <TextField label="First name" autoComplete="given-name" {...field('firstName')} />
          <TextField label="Last name" autoComplete="family-name" {...field('lastName')} />
          <TextField label="Email" type="email" autoComplete="email" {...field('email')} />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            helperText="At least 8 characters"
            {...field('password')}
          />
          <TextField
            label="Phone number"
            placeholder="(123) 456-7890"
            autoComplete="tel"
            {...field('phoneNumber')}
          />
          <LocalizationProvider dateAdapter={AdapterDayjs}>
            <DatePicker
              label="Date of birth"
              value={dateOfBirth}
              onChange={setDateOfBirth}
              disableFuture
            />
          </LocalizationProvider>
          <Button type="submit" variant="contained" disabled={pending} className="sm:col-span-2">
            Create account
          </Button>
          <Typography variant="body2" className="sm:col-span-2">
            Have an account?{' '}
            <Link href="/sign-in" className="text-sky-600">
              Sign in
            </Link>
          </Typography>
        </form>
      </Paper>
    </div>
  );
}
