import { createError, defineEventHandler, readBody, setResponseStatus } from 'h3';
import { DELIVERY_FEE, type MealInOrder, type Order } from '#shared/types';
import { authorize, callerOf, dropInstances, isAllowed, permitWrite } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { MAX_ORDERS_PER_CITY, readStore, trimCity, updateStore } from '#server/utils/store';
import { parseNewOrder } from '#server/utils/validate';

/** Places an order for meals from one vendor in the caller's city. */
export default defineEventHandler(async (event): Promise<{ id: number; deliveryFee: number }> => {
  const caller = callerOf(event);
  const { tenant } = caller;
  const lines = parseNewOrder(await readBody<unknown>(event)).meals;
  // Permit check: customers and admins may place orders in their city (RBAC).
  await authorize(caller, 'create', { type: 'Order' });

  const menu = readStore().meals.filter((meal) => meal.city === tenant);
  const meals: MealInOrder[] = [];
  const vendors = new Set<string>();
  for (const { id, quantity } of lines) {
    const meal = menu.find((candidate) => candidate.id === id);
    if (meal === undefined) {
      throw createError({ statusCode: 400, message: `Meal ${id} is not on the menu in ${tenant}` });
    }
    meals.push({ id, name: meal.name, price: meal.price, quantity });
    vendors.add(meal.vendor);
  }
  const [vendor] = vendors;
  if (vendor === undefined || vendors.size > 1) {
    throw createError({ statusCode: 400, message: 'An order holds meals from one vendor only.' });
  }
  const totalPrice = meals.reduce((sum, { price, quantity }) => sum + price * quantity, 0);

  // Permit check: free delivery for orders of 500 or more (ABAC: the role's permission on the
  // orders_above_500 resource set). The cost goes with the check.
  const freeDelivery = await isAllowed(caller, 'create-with-free-delivery', {
    type: 'Order',
    attributes: { cost: totalPrice },
  });
  const deliveryFee = freeDelivery ? 0 : DELIVERY_FEE;

  const id = updateStore((data) => data.nextOrderId++);
  const key = String(id);
  await permitWrite(`create order ${key}`, () =>
    // Permit write: registers the order as an Order instance in the caller's city. The cost is
    // not stored on it: see README.md, "Where the app asks Permit".
    permit().api.resourceInstances.create({ key, resource: 'Order', tenant }),
  );
  await permitWrite(`make ${vendor} the vendor of order ${key}`, () =>
    // Permit write: gives the meals' vendor Order#Vendor on this order, so they may fulfill it
    // (ReBAC).
    permit().api.roleAssignments.assign({
      user: vendor,
      role: 'Vendor',
      resource_instance: `Order:${key}`,
      tenant,
    }),
  );

  const order: Order = {
    id,
    city: tenant,
    meals,
    customer: caller.user,
    vendor,
    totalPrice,
    deliveryFee,
    grandTotal: totalPrice + deliveryFee,
    orderTime: new Date().toISOString(),
  };
  const dropped = updateStore((data) => {
    data.orders.unshift(order);
    const { kept, dropped } = trimCity(data.orders, tenant, MAX_ORDERS_PER_CITY);
    data.orders = kept;
    return dropped;
  });
  await dropInstances('Order', dropped);

  setResponseStatus(event, 201);
  return { id, deliveryFee };
});
