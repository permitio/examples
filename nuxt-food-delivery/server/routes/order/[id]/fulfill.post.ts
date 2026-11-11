import { createError, defineEventHandler, getRouterParam } from 'h3';
import type { ApiMessage } from '#shared/types';
import { authorize, callerOf } from '#server/utils/api';
import { findOrder, readStore, updateStore } from '#server/utils/store';

/** Marks an order as ready for delivery. */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const caller = callerOf(event);
  const id = getRouterParam(event, 'id');
  const order = findOrder(readStore(), id, caller.tenant);
  // Permit check: the order's own vendor (Order#Vendor, ReBAC) or an admin (RBAC) may fulfill it.
  // The order's key makes Permit look at the caller's roles on this order.
  await authorize(caller, 'fulfill', { type: 'Order', key: String(order.id) });

  updateStore((data) => {
    const current = findOrder(data, id, caller.tenant);
    if (current.fulfilledTime !== undefined) {
      throw createError({ statusCode: 409, message: `Order ${order.id} is already fulfilled` });
    }
    current.fulfilledTime = new Date().toISOString();
  });
  return { message: `Order ${order.id} fulfilled` };
});
