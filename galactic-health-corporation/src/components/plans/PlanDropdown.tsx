'use client';

import { FormControl, MenuItem, Select, type SelectChangeEvent, Skeleton } from '@mui/material';
import { useEffect, useState } from 'react';
import { type UserResource, useUserContext } from '@/contexts/UserContext';

/**
 * Picks whose dashboard to show: the signed-in member's own, or that of a member who made them a
 * caregiver. Hidden when there is no one else to pick.
 */
export function PlanDropdown() {
  const { currentUser, setCurrentUser, loggedInUser } = useUserContext();
  const [users, setUsers] = useState<UserResource[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/allowed-plans', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`/api/allowed-plans answered ${response.status}`);
        setUsers((await response.json()) as UserResource[]);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Could not load the dashboards you can view', error);
        setUsers([]);
      });
    return () => controller.abort();
  }, []);

  if (users === null) return <Skeleton variant="rectangular" width={200} height={40} />;
  if (users.length <= 1) return null;

  const select = (event: SelectChangeEvent) => {
    setCurrentUser(users.find((user) => user.id === event.target.value) ?? null);
  };

  return (
    <FormControl variant="outlined" size="small" sx={{ width: 240 }}>
      <Select value={currentUser?.id ?? ''} onChange={select} displayEmpty>
        {users.map((user) => (
          <MenuItem key={user.id} value={user.id}>
            {user.firstName} {user.lastName}
            {user.id === loggedInUser?.id ? ' (signed in)' : ''}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
