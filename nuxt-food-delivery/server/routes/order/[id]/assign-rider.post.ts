import { createError, defineEventHandler, getRouterParam, readBody } from 'h3';
import type { ApiMessage } from '#shared/types';
import { authorize, callerOf, permitWrite, permitWriteOnce } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { findOrder, readStore, updateStore } from '#server/utils/store';
import { parseRider } from '#server/utils/validate';

/** Assigns a rider to an order. A rider Permit does not know yet is created with the rider role. */
export default defineEventHandler(async (event): Promise<ApiMessage> => {
  const caller = callerOf(event);
  const { tenant } = caller;
  const id = getRouterParam(event, 'id');
  const rider = parseRider(await readBody<unknown>(event));
  const order = findOrder(readStore(), id, tenant);
  const key = String(order.id);
  // Permit check: admins may assign riders (RBAC).
  await authorize(caller, 'assign-rider', { type: 'Order', key });
  if (order.riderAssignedTime !== undefined) {
    throw createError({ statusCode: 409, message: `Order ${key} already has a rider` });
  }

  await permitWriteOnce(
    `create user ${rider}`,
    // Permit write: creates the rider as a user; a 409 means the user exists already.
    () => permit().api.users.create({ key: rider }),
    409,
  );
  await permitWriteOnce(
    `give ${rider} the rider role in ${tenant}`,
    // Permit write: gives the rider the rider role in this city (RBAC).
    () => permit().api.roleAssignments.assign({ user: rider, role: 'rider', tenant }),
    409,
  );
  await permitWrite(`make ${rider} the rider of order ${key}`, () =>
    // Permit write: gives the rider Order#Rider on this order, so they may deliver it (ReBAC).
    permit().api.roleAssignments.assign({
      user: rider,
      role: 'Rider',
      resource_instance: `Order:${key}`,
      tenant,
    }),
  );

  updateStore((data) => {
    const current = findOrder(data, id, tenant);
    current.admin = caller.user;
    current.rider = rider;
    current.riderAssignedTime = new Date().toISOString();
  });
  return { message: `${rider} assigned to order ${key}` };
});
