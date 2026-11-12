import { createError, defineEventHandler, getRouterParam } from 'h3';
import type { ApiMessage } from '#shared/types';
import { authorize, callerOf } from '#server/utils/api';
import { findOrder, readStore, updateStore } from '#server/utils/store';

/** Marks an order as delivered. */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const caller = callerOf(event);
  const id = getRouterParam(event, 'id');
  const order = findOrder(readStore(), id, caller.tenant);
  // Permit check: the order's own rider (Order#Rider, ReBAC) or an admin (RBAC) may deliver it.
  await authorize(caller, 'deliver', { type: 'Order', key: String(order.id) });
  if (order.deliveryFee === 0) {
    // Permit check: a free-delivery order also needs a rider with 500 or more rides (ABAC: the
    // experienced_riders user set on the orders_above_500 resource set), or an admin. The cost goes
    // with the check, without the order's key, so only roles and attributes decide it.
    await authorize(caller, 'deliver', { type: 'Order', attributes: { cost: order.totalPrice } });
  }

  updateStore((data) => {
    const current = findOrder(data, id, caller.tenant);
    if (current.deliveredTime !== undefined) {
      throw createError({ statusCode: 409, message: `Order ${order.id} is already delivered` });
    }
    current.deliveredTime = new Date().toISOString();
  });
  return { message: `Order ${order.id} delivered` };
});
