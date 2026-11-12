import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import { nanoid } from 'nanoid';
import { authorize, callerOf, dropInstances, permitWrite } from '#server/utils/api';
import { permit } from '#server/utils/permit';
import { MAX_MEALS_PER_CITY, trimCity, updateStore } from '#server/utils/store';
import { parseNewMeal } from '#server/utils/validate';

/** Adds a meal to the caller's city's menu, sold by the caller. */
export default defineEventHandler(async (event): Promise<{ id: string }> => {
  const caller = callerOf(event);
  const { name, price } = parseNewMeal(await readBody<unknown>(event));
  // Permit check: vendors and admins may create meals in their city (RBAC).
  await authorize(caller, 'create', { type: 'Meal' });

  const id = nanoid();
  await permitWrite(`create meal ${id}`, () =>
    // Permit write: registers the meal as a Meal instance in the caller's city.
    permit().api.resourceInstances.create({ key: id, resource: 'Meal', tenant: caller.tenant }),
  );
  const dropped = updateStore((data) => {
    data.meals.unshift({ id, name, price, vendor: caller.user, city: caller.tenant });
    const { kept, dropped } = trimCity(data.meals, caller.tenant, MAX_MEALS_PER_CITY);
    data.meals = kept;
    return dropped;
  });
  await dropInstances('Meal', dropped);

  setResponseStatus(event, 201);
  return { id };
});
