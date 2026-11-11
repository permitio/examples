'use client';

import { createContext, type ReactNode, use, useMemo, useState } from 'react';

export interface UserResource {
  id: string;
  firstName: string;
  lastName: string;
}

export interface UserContextValue {
  /** The member who is signed in. */
  loggedInUser: UserResource | null;
  /** The member whose dashboard is shown: the signed-in member, or someone they care for. */
  currentUser: UserResource | null;
  setCurrentUser: (user: UserResource | null) => void;
}

const UserContext = createContext<UserContextValue | null>(null);

/**
 * Holds the signed-in member (from the server's session) and the dashboard being viewed. Give it a
 * `key` of the member's id so that signing in as someone else starts from a fresh state.
 */
export function UserContextProvider({
  loggedInUser,
  children,
}: {
  loggedInUser: UserResource | null;
  children: ReactNode;
}) {
  const [currentUser, setCurrentUser] = useState(loggedInUser);
  const value = useMemo(
    () => ({ loggedInUser, currentUser, setCurrentUser }),
    [loggedInUser, currentUser],
  );
  return <UserContext value={value}>{children}</UserContext>;
}

export function useUserContext(): UserContextValue {
  const context = use(UserContext);
  if (context === null) {
    throw new Error('useUserContext must be used inside a UserContextProvider.');
  }
  return context;
}
