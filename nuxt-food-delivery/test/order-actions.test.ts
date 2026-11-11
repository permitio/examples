import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const paidOrder = anOrder({ id: 1 });
const freeOrder = anOrder({
  id: 2,
  meals: [{ id: 'party-pizza-box', name: 'Party pizza box', price: 520, quantity: 1 }],
  totalPrice: 520,
  deliveryFee: 0,
  grandTotal: 520,
});

beforeEach(() => {
  vi.resetAllMocks();
  useTestEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  storeOrders(freeOrder, paidOrder, anOrder({ id: 3, city: 'washington' }));
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /order/:id/fulfill', () => {
  const vendor = { user: 'vendor1' };

  it("asks Permit about this order (the vendor's Order#Vendor) and fulfills it", async () => {
    const reply = await server.post('/order/1/fulfill', undefined, vendor);

    expect(reply).toEqual({ status: 200, body: { message: 'Order 1 fulfilled' } });
    expect(permit.check).toHaveBeenCalledWith('vendor1', 'fulfill', {
      type: 'Order',
      key: '1',
      tenant: 'california',
    });
    expect(order(1)?.fulfilledTime).toEqual(expect.any(String));
  });

  it("answers 403 for a vendor who is not the order's vendor", async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.post('/order/1/fulfill', undefined, { user: 'vendor2' });

    expect(reply.status).toBe(403);
    expect(order(1)?.fulfilledTime).toBeUndefined();
  });

  it('answers 409 for an order that is already fulfilled', async () => {
    await server.post('/order/1/fulfill', undefined, vendor);

    const reply = await server.post('/order/1/fulfill', undefined, vendor);

    expect(reply).toMatchObject({ status: 409, body: { message: 'Order 1 is already fulfilled' } });
  });

  it.each([
    ['an order that does not exist', '9'],
    ["another city's order", '3'],
  ])('answers 404 for %s, without asking Permit', async (_case, id) => {
    const reply = await server.post(`/order/${id}/fulfill`, undefined, vendor);

    expect(reply).toMatchObject({
      status: 404,
      body: { message: `Order ${id} not found in california` },
    });
    expect(permit.check).not.toHaveBeenCalled();
  });

  it('answers 502 when the PDP cannot be reached', async () => {
    permit.check.mockRejectedValue(pdpDown());

    expect((await server.post('/order/1/fulfill', undefined, vendor)).status).toBe(502);
    expect(order(1)?.fulfilledTime).toBeUndefined();
  });
});

describe('POST /order/:id/assign-rider', () => {
  const admin = { user: 'admin1' };

  it('creates the rider if needed, gives them the rider role and Order#Rider', async () => {
    const reply = await server.post('/order/1/assign-rider', { rider: 'rider1' }, admin);

    expect(reply).toEqual({ status: 200, body: { message: 'rider1 assigned to order 1' } });
    expect(permit.check).toHaveBeenCalledWith('admin1', 'assign-rider', {
      type: 'Order',
      key: '1',
      tenant: 'california',
    });
    expect(permit.api.users.create).toHaveBeenCalledWith({ key: 'rider1' });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'rider1',
      role: 'rider',
      tenant: 'california',
    });
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledWith({
      user: 'rider1',
      role: 'Rider',
      resource_instance: 'Order:1',
      tenant: 'california',
    });
    expect(order(1)).toMatchObject({
      admin: 'admin1',
      rider: 'rider1',
      riderAssignedTime: expect.any(String),
    });
  });

  it('goes on when the rider exists already and has the rider role (409s)', async () => {
    permit.api.users.create.mockRejectedValue(apiError(409));
    permit.api.roleAssignments.assign.mockRejectedValueOnce(apiError(409));

    const reply = await server.post('/order/1/assign-rider', { rider: 'rider1' }, admin);

    expect(reply.status).toBe(200);
    expect(permit.api.roleAssignments.assign).toHaveBeenCalledTimes(2);
    expect(order(1)?.rider).toBe('rider1');
  });

  it('answers 403 and writes nothing when Permit denies assign-rider', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.post(
      '/order/1/assign-rider',
      { rider: 'rider1' },
      { user: 'vendor1' },
    );

    expect(reply.status).toBe(403);
    expect(permit.api.users.create).not.toHaveBeenCalled();
    expect(permit.api.roleAssignments.assign).not.toHaveBeenCalled();
    expect(order(1)?.rider).toBeUndefined();
  });

  it('answers 409 for an order that has a rider', async () => {
    await server.post('/order/1/assign-rider', { rider: 'rider1' }, admin);

    const reply = await server.post('/order/1/assign-rider', { rider: 'rider2' }, admin);

    expect(reply).toMatchObject({ status: 409, body: { message: 'Order 1 already has a rider' } });
    expect(order(1)?.rider).toBe('rider1');
  });

  it('answers 400 for a rider key Permit would not take', async () => {
    const reply = await server.post('/order/1/assign-rider', { rider: 'bad rider!' }, admin);

    expect(reply.status).toBe(400);
    expect(permit.check).not.toHaveBeenCalled();
  });

  it('answers 502 and leaves the order unassigned when Permit fails to assign', async () => {
    permit.api.roleAssignments.assign.mockRejectedValue(apiError(500));

    const reply = await server.post('/order/1/assign-rider', { rider: 'rider1' }, admin);

    expect(reply.status).toBe(502);
    expect(order(1)?.rider).toBeUndefined();
  });
});

describe('POST /order/:id/deliver', () => {
  it("asks once about a paid order (the rider's Order#Rider) and delivers it", async () => {
    const reply = await server.post('/order/1/deliver', undefined, { user: 'rider1' });

    expect(reply).toEqual({ status: 200, body: { message: 'Order 1 delivered' } });
    expect(permit.check).toHaveBeenCalledTimes(1);
    expect(permit.check).toHaveBeenCalledWith('rider1', 'deliver', {
      type: 'Order',
      key: '1',
      tenant: 'california',
    });
    expect(order(1)?.deliveredTime).toEqual(expect.any(String));
  });

  it('also asks, with the cost and without the key, whether the rider may deliver free orders', async () => {
    const reply = await server.post('/order/2/deliver', undefined, { user: 'rider2' });

    expect(reply.status).toBe(200);
    expect(permit.check).toHaveBeenNthCalledWith(1, 'rider2', 'deliver', {
      type: 'Order',
      key: '2',
      tenant: 'california',
    });
    expect(permit.check).toHaveBeenNthCalledWith(2, 'rider2', 'deliver', {
      type: 'Order',
      attributes: { cost: 520 },
      tenant: 'california',
    });
  });

  it('answers 403 for an assigned rider without enough rides on a free order', async () => {
    permit.decide.mockImplementation((_user, _action, resource) => resource.key !== undefined);

    const reply = await server.post('/order/2/deliver', undefined, { user: 'rider1' });

    expect(reply.status).toBe(403);
    expect(order(2)?.deliveredTime).toBeUndefined();
  });

  it('answers 403 for a rider who is not assigned, without asking the second question', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.post('/order/2/deliver', undefined, { user: 'rider2' });

    expect(reply.status).toBe(403);
    expect(permit.check).toHaveBeenCalledTimes(1);
  });

  it('answers 409 for an order that is already delivered', async () => {
    await server.post('/order/1/deliver', undefined, { user: 'rider1' });

    const reply = await server.post('/order/1/deliver', undefined, { user: 'rider1' });

    expect(reply).toMatchObject({ status: 409, body: { message: 'Order 1 is already delivered' } });
  });

  it("answers 404 for another city's order", async () => {
    expect((await server.post('/order/3/deliver', undefined, { user: 'rider1' })).status).toBe(404);
  });

  it('answers 502 when the PDP cannot be reached', async () => {
    permit.check.mockRejectedValue(pdpDown());

    expect((await server.post('/order/1/deliver', undefined, { user: 'rider1' })).status).toBe(502);
  });
});
