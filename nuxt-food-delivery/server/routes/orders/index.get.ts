import { defineEventHandler } from 'h3';
import type { Order } from '#shared/types';
import { authorize, callerOf } from '#server/utils/api';
import { readStore } from '#server/utils/store';

/** The caller's city's orders, newest first. */
export default defineEventHandler(async (event): Promise<Order[]> => {
  const caller = callerOf(event);
  // Permit check: every role may read orders, but only in a city where the caller has a role
  // (RBAC).
  await authorize(caller, 'read', { type: 'Order' });
  return readStore().orders.filter((order) => order.city === caller.tenant);
});
