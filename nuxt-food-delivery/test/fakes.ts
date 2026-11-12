import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermitApiError, PermitConnectionError } from 'permitio';
import { vi } from 'vitest';
import type { Order } from '#shared/types';
import { readStore, writeStore } from '#server/utils/store';

/** An error as the SDK throws it when Permit's API answers `status`. */
export function apiError(status: number): PermitApiError<unknown> {
  const message = `Request failed with status code ${status}`;
  const axiosError = { message, response: { status, data: { message: 'from Permit' } } };
  return new PermitApiError(
    message,
    axiosError as unknown as ConstructorParameters<typeof PermitApiError>[1],
  );
}

/** An error as the SDK throws it when the PDP cannot be reached. */
export const pdpDown = () => new PermitConnectionError('connect ECONNREFUSED 127.0.0.1:7766');

/**
 * Points the app at a fresh, empty data directory (in the OS temp folder, which the OS clears) and
 * at a fake Permit environment.
 */
export function useTestEnv(): void {
  vi.stubEnv('DATA_DIR', mkdtempSync(join(tmpdir(), 'food-delivery-')));
  vi.stubEnv('PERMIT_API_KEY', 'test-api-key');
  vi.stubEnv('PERMIT_PDP_URL', 'http://pdp.test:7000');
  vi.stubEnv('PERMIT_API_URL', 'http://api.test');
}

/** An order as the store holds it, with the parts a test does not care about filled in. */
export function anOrder(fields: Partial<Order> & Pick<Order, 'id'>): Order {
  return {
    city: 'california',
    meals: [{ id: 'margherita-pizza', name: 'Margherita pizza', price: 120, quantity: 1 }],
    customer: 'customer1',
    vendor: 'vendor1',
    totalPrice: 120,
    deliveryFee: 50,
    grandTotal: 170,
    orderTime: '2026-11-10T09:00:00.000Z',
    ...fields,
  };
}

/** Puts orders in the store, as if they had been placed. */
export function storeOrders(...orders: Order[]): void {
  const data = readStore();
  data.orders = orders;
  data.nextOrderId = Math.max(0, ...orders.map((order) => order.id)) + 1;
  writeStore(data);
}
