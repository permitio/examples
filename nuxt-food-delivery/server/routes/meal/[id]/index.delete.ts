import { createError, defineEventHandler, getRouterParam } from 'h3';
import type { ApiMessage } from '#shared/types';
import { authorize, callerOf, permitWriteOnce } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { readStore, updateStore } from '#server/utils/store';

/** Removes a meal from the caller's city's menu. */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const caller = callerOf(event);
  const id = getRouterParam(event, 'id') ?? '';
  const meal = readStore().meals.find((m) => m.id === id && m.city === caller.tenant);
  if (meal === undefined) {
    throw createError({ statusCode: 404, message: `Meal ${id} not found in ${caller.tenant}` });
  }
  // Permit check: vendors and admins may delete meals in their city (RBAC).
  await authorize(caller, 'delete', { type: 'Meal', key: id });

  await permitWriteOnce(
    `delete meal ${id}`,
    // Permit write: deletes the Meal instance; a 404 means Permit never had it.
    () => permit().api.resourceInstances.delete(`Meal:${id}`),
    404,
  );
  updateStore((data) => {
    data.meals = data.meals.filter((m) => m.id !== id);
  });
  return { message: `${meal.name} removed from the menu` };
});
