import type { LegacyUser, SeedAccount } from '#src/seed';

/**
 * The legacy app's own rule for its one protected action, view billing on a child account: the user
 * is an admin, or their `accounts` hold the account's code or its EAN's. A user the legacy table
 * does not know has no access.
 */
export function legacyAllows(user: LegacyUser | undefined, account: SeedAccount): boolean {
  if (user === undefined) return false;
  return (
    user.is_admin || user.accounts.includes(account.key) || user.accounts.includes(account.ean)
  );
}
