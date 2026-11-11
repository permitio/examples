import { defineStore } from 'pinia';
import { useCookie } from '#imports';
import type { ApiMessage, RoleChange } from '#shared/types';

/**
 * The user the app acts as. It stands in for sign-in: pick any user key, and the server asks Permit
 * about that user. A cookie keeps it, so server-side rendering asks as the same user.
 */
export const useUserStore = defineStore('user', () => {
  const current = useCookie<string>('food-delivery-user', {
    default: () => 'customer1',
    sameSite: 'lax',
  });

  /** Grants or revokes a role in a city (`POST /users`). */
  const updateRole = (change: RoleChange) =>
    $fetch<ApiMessage>('/users', { method: 'POST', body: change });

  /** Deletes the current user from Permit (`DELETE /users`). */
  const remove = () =>
    $fetch<ApiMessage>('/users', { method: 'DELETE', body: { user: current.value } });

  return { current, updateRole, remove };
});
