import { createError } from 'h3';
import { isCity, isRole, type NewMeal, type NewOrder, type RoleChange } from '#shared/types';

/** User keys the app accepts: letters, digits and `_ . @ -`, as Permit user keys usually are. */
const USER_KEY = /^[\w.@-]{1,64}$/;

const badRequest = (message: string) => createError({ statusCode: 400, message });

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Send a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function parseUserKey(value: unknown, field = 'user'): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!USER_KEY.test(key)) {
    throw badRequest(`${field} must be 1-64 letters, digits, or _ . @ - characters.`);
  }
  return key;
}

export function parseNewMeal(body: unknown): NewMeal {
  const { name, price } = objectBody(body);
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 3 || trimmed.length > 60) {
    throw badRequest('name must be 3 to 60 characters.');
  }
  const amount = typeof price === 'string' && price.trim() !== '' ? Number(price) : price;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw badRequest('price must be a number greater than zero.');
  }
  return { name: trimmed, price: amount };
}

export function parseNewOrder(body: unknown): NewOrder {
  const { meals } = objectBody(body);
  if (!Array.isArray(meals) || meals.length === 0) {
    throw badRequest('meals must list at least one meal.');
  }
  return {
    meals: meals.map((line: unknown) => {
      const { id, quantity } = objectBody(line);
      if (typeof id !== 'string' || id === '') throw badRequest('Each meal needs an id.');
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
        throw badRequest('Each meal needs a whole quantity of 1 or more.');
      }
      return { id, quantity };
    }),
  };
}

export function parseRider(body: unknown): string {
  return parseUserKey(objectBody(body)['rider'], 'rider');
}

/** Body of `DELETE /users`: `{ user }`. */
export function parseUserRemoval(body: unknown): string {
  return parseUserKey(objectBody(body)['user']);
}

export function parseRoleChange(body: unknown): RoleChange {
  const fields = objectBody(body);
  const { role, tenant, isGrant, noOfRides } = fields;
  if (!isRole(role)) throw badRequest(`Unknown role: ${String(role)}`);
  if (!isCity(tenant)) throw badRequest(`Unknown city: ${String(tenant)}`);
  if (typeof isGrant !== 'boolean') throw badRequest('isGrant must be true or false.');
  const change: RoleChange = { user: parseUserKey(fields['user']), role, tenant, isGrant };
  if (noOfRides === undefined) return change;
  if (typeof noOfRides !== 'number' || !Number.isInteger(noOfRides) || noOfRides < 0) {
    throw badRequest('noOfRides must be a whole number of 0 or more.');
  }
  return { ...change, noOfRides };
}
