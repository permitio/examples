/**
 * The demo's content. Every request acts as the same signed-in user, so the only thing that changes
 * Permit's answer is what kind of caller sent the request.
 */

/** The signed-in user. A real app takes this from its session. */
export const USER_KEY = 'user@example.com';
const OTHER_USER_KEY = 'other-user@example.com';

export interface Item {
  id: number;
  name: string;
  owner: string;
  private: boolean;
}

export const ITEMS: readonly Item[] = [
  { id: 1, name: 'Public Item', owner: USER_KEY, private: false },
  { id: 2, name: 'Shared Item', owner: OTHER_USER_KEY, private: false },
  { id: 3, name: 'Private Item', owner: USER_KEY, private: true },
  { id: 4, name: 'Blocked Item', owner: OTHER_USER_KEY, private: true },
];
