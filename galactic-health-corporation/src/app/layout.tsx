import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import type { Metadata } from 'next';
import { DM_Serif_Display, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import '@/app/globals.css';
import { NavBar } from '@/components/nav/NavBar';
import { PermissionsProvider } from '@/components/PermissionsProvider';
import { UserContextProvider } from '@/contexts/UserContext';
import { currentUser } from '@/lib/session';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const serif = DM_Serif_Display({ subsets: ['latin'], weight: '400', variable: '--font-dm-serif' });

export const metadata: Metadata = {
  title: 'Galactic Health Corporation',
  description: 'A Permit.io example: RBAC, ReBAC and ABAC in one healthcare portal',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const member =
    user === null ? null : { id: user.id, firstName: user.firstName, lastName: user.lastName };
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable}`}>
      <body className="font-sans">
        <AppRouterCacheProvider options={{ enableCssLayer: true }}>
          <UserContextProvider key={member?.id ?? 'signed-out'} loggedInUser={member}>
            <PermissionsProvider>
              {member === null ? null : <NavBar />}
              {children}
            </PermissionsProvider>
          </UserContextProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
