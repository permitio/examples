import { inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { Auth } from '@/lib/auth';

/** Better Auth in the browser: sign-up, sign-in and sign-out against `/api/auth`. */
export const authClient = createAuthClient({ plugins: [inferAdditionalFields<Auth>()] });
