import { defineEventHandler } from 'h3';
import type { Meal } from '#shared/types';
import { authorize, callerOf } from '#server/utils/api';
import { readStore } from '#server/utils/store';

/** The caller's city's menu. */
export default defineEventHandler(async (event): Promise<Meal[]> => {
  const caller = callerOf(event);
  // Permit check: every role may read meals, but only in a city where the caller has a role (RBAC).
  await authorize(caller, 'read', { type: 'Meal' });
  return readStore().meals.filter((meal) => meal.city === caller.tenant);
});
