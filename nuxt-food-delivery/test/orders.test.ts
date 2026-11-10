import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Order } from '#shared/types';
import { readStore } from '#server/utils/store';
import { anOrder, apiError, pdpDown, storeOrders, useTestEnv } from '#test/fakes';
import { testServer } from '#test/server';

const permit = await vi.hoisted(async () => (await import('#test/fake-permit')).fakePermit());
vi.mock('permitio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permitio')>()),
  Permit: vi.fn(function Permit() {
    return permit;
  }),
}));

const server = testServer();
const order = (id: number) => readStore().orders.find((candidate) => candidate.id === id);

beforeEach(() => {
  vi.resetAllMocks();
  useTestEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /orders', () => {
  it("returns the caller's city's orders when Permit allows read", async () => {
    storeOrders(anOrder({ id: 2 }), anOrder({ id: 1, city: 'washington' }));

    const reply = await server.get<Order[]>('/orders', { user: 'rider1' });

    expect(reply.status).toBe(200);
    expect(reply.body.map(({ id }) => id)).toEqual([2]);
    expect(permit.check).toHaveBeenCalledWith('rider1', 'read', {
      type: 'Order',
      tenant: 'california',
    });
  });

  it('answers 403 when Permit denies read in that city', async () => {
    permit.decide.mockReturnValue(false);

    expect((await server.get('/orders', { city: 'washington' })).status).toBe(403);
  });

  it('answers 502 when the PDP cannot be reached', async () => {
    permit.check.mockRejectedValue(pdpDown());

    expect((await server.get('/orders')).status).toBe(502);
  });
});

describe('POST /orders', () => {
  const pizza = { meals: [{ id: 'margherita-pizza', quantity: 2 }] };

  it('places the order, registers it in Permit, and makes the vendor its Order#Vendor', async () => {
    permit.decide.mockImplementation((_user, action) => action !== 'create-with-free-delivery');

    const reply = await server.post('/orders', pizza);

    expect(reply).toEqual({ status: 201, body: { id: 1, deliveryFee: 50 } });
    expect(permit.check).toHaveBeenCalledWith('customer1', 'create', {
      type: 'Order',
      tenant: 'california',
    });
    expect(permit.api.resourceInstances.create).toHaveBeenCalledWith({
      key: '1',
      resource: 'Order',
      tenant: 'california',
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'vendor1',
      role: 'Vendor',
      resource_instance: 'Order:1',
      tenant: 'california',
    });
    expect(order(1)).toMatchObject({
      city: 'california',
      customer: 'customer1',
      vendor: 'vendor1',
      meals: [{ id: 'margherita-pizza', name: 'Margherita pizza', price: 120, quantity: 2 }],
      totalPrice: 240,
      deliveryFee: 50,
      grandTotal: 290,
    });
  });

  it('asks Permit about free delivery with the cost, and waives the fee when allowed', async () => {
    const reply = await server.post('/orders', { meals: [{ id: 'party-pizza-box', quantity: 1 }] });

    expect(reply.body).toEqual({ id: 1, deliveryFee: 0 });
    expect(permit.check).toHaveBeenCalledWith('customer1', 'create-with-free-delivery', {
      type: 'Order',
      attributes: { cost: 520 },
      tenant: 'california',
    });
    expect(order(1)).toMatchObject({ totalPrice: 520, deliveryFee: 0, grandTotal: 520 });
  });

  it('numbers orders one after another', async () => {
    await server.post('/orders', pizza);
    const reply = await server.post('/orders', pizza);

    expect(reply.body).toMatchObject({ id: 2 });
  });

  it('answers 403 and writes nothing when Permit denies create', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.post('/orders', pizza, { user: 'vendor1' });

    expect(reply.status).toBe(403);
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
    expect(readStore().orders).toEqual([]);
  });

  it.each([
    ['no meals', { meals: [] }, 'meals must list at least one meal.'],
    ['a quantity of zero', { meals: [{ id: 'miso-soup', quantity: 0 }] }, 'whole quantity'],
    ['a meal without an id', { meals: [{ quantity: 1 }] }, 'Each meal needs an id.'],
  ])('answers 400 for %s, without asking Permit', async (_case, body, message) => {
    const reply = await server.post<{ message: string }>('/orders', body);

    expect(reply.status).toBe(400);
    expect(reply.body.message).toContain(message);
    expect(permit.check).not.toHaveBeenCalled();
  });

  it.each([
    ['a meal that does not exist', 'no-such-meal'],
    ["another city's meal", 'clam-chowder'],
  ])('answers 400 for %s', async (_case, id) => {
    const reply = await server.post('/orders', { meals: [{ id, quantity: 1 }] });

    expect(reply).toMatchObject({
      status: 400,
      body: { message: `Meal ${id} is not on the menu in california` },
    });
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
  });

  it('answers 400 for meals from two vendors', async () => {
    const meals = [
      { id: 'margherita-pizza', quantity: 1 },
      { id: 'miso-soup', quantity: 1 },
    ];

    const reply = await server.post('/orders', { meals });

    expect(reply).toMatchObject({
      status: 400,
      body: { message: 'An order holds meals from one vendor only.' },
    });
  });

  it('answers 502 and saves no order when Permit cannot assign the vendor', async () => {
    permit.api.roleAssignments.assign.mockRejectedValue(apiError(404));

    const reply = await server.post('/orders', pizza);

    expect(reply).toMatchObject({
      status: 502,
      body: {
        message: 'Permit could not make vendor1 the vendor of order 1 (Permit answered 404).',
      },
    });
    expect(readStore().orders).toEqual([]);
  });

  it('answers 502 when the PDP cannot answer the free-delivery check', async () => {
    permit.check.mockImplementation(async (_user, action) => {
      if (action === 'create-with-free-delivery') throw pdpDown();
      return true;
    });

    expect((await server.post('/orders', pizza)).status).toBe(502);
    expect(readStore().orders).toEqual([]);
  });

  it("keeps fifty orders per city and removes the dropped order's instance from Permit", async () => {
    storeOrders(...Array.from({ length: 50 }, (_, n) => anOrder({ id: 50 - n })));

    await server.post('/orders', pizza);

    const ids = readStore().orders.map(({ id }) => id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(51);
    expect(ids).not.toContain(1);
    expect(permit.api.resourceInstances.delete).toHaveBeenCalledWith('Order:1');
  });
});
