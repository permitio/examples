import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createError } from 'h3';
import { SEED_MEALS } from '#shared/demo';
import type { City, Meal, Order } from '#shared/types';

/**
 * The app's own data, in a JSON file standing in for a database. Permit holds only what it needs to
 * decide: each meal and order as a resource instance (key and city), and who holds which role.
 */
export interface StoreData {
  meals: Meal[];
  orders: Order[];
  nextOrderId: number;
}

/** How many meals and orders each city keeps; older ones are dropped (and removed from Permit). */
export const MAX_MEALS_PER_CITY = 10;
export const MAX_ORDERS_PER_CITY = 50;

const storePath = () => join(process.env['DATA_DIR'] || '.data', 'store.json');

/** Reads the store, starting from the demo menu when there is no store file yet. */
export function readStore(): StoreData {
  const path = storePath();
  if (!existsSync(path)) {
    return { meals: SEED_MEALS.map((meal) => ({ ...meal })), orders: [], nextOrderId: 1 };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as StoreData;
}

/** Writes the whole store; the rename makes the write atomic. */
export function writeStore(data: StoreData): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

/**
 * Reads the store, applies `change`, and writes it back, all synchronously, so no other request
 * runs in between. When `change` throws, nothing is written.
 */
export function updateStore<T>(change: (data: StoreData) => T): T {
  const data = readStore();
  const result = change(data);
  writeStore(data);
  return result;
}

/**
 * Keeps the newest `max` items of `city` (the store lists newest first) and returns the keys of the
 * ones it dropped.
 */
export function trimCity<T extends { city: City; id: string | number }>(
  items: T[],
  city: City,
  max: number,
): { kept: T[]; dropped: string[] } {
  const dropped = items
    .filter((item) => item.city === city)
    .slice(max)
    .map((item) => String(item.id));
  return { kept: items.filter((item) => !dropped.includes(String(item.id))), dropped };
}

/** The order with this id in this city; a 404 when there is none. */
export function findOrder(data: StoreData, id: string | undefined, city: City): Order {
  const order = data.orders.find((candidate) => String(candidate.id) === id);
  if (order === undefined || order.city !== city) {
    throw createError({ statusCode: 404, message: `Order ${id ?? ''} not found in ${city}` });
  }
  return order;
}
