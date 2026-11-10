import { defineEventHandler, readBody } from 'h3';
import type { ApiMessage } from '#shared/types';
import { permitWriteOnce } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { parseUserRemoval } from '#server/utils/validate';

/**
 * Deletes a user from Permit, with all their roles and attributes. Part of the demo's user
 * switcher, so it has no Permit check of its own; a real app would guard it.
 */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const user = parseUserRemoval(await readBody<unknown>(event));
  await permitWriteOnce(
    `delete user ${user}`,
    // Permit write: deletes the user; a 404 means Permit did not have them.
    () => permit().api.users.delete(user),
    404,
  );
  return { message: `User ${user} removed from Permit` };
});
