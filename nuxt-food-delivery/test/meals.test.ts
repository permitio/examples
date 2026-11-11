import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meal } from '#shared/types';
import { readStore } from '#server/utils/store';
import { apiError, pdpDown, useTestEnv } from '#test/fakes';
import { testServer } from '#test/server';

const permit = await vi.hoisted(async () => (await import('#test/fake-permit')).fakePermit());
vi.mock('permitio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('permitio')>()),
  Permit: vi.fn(function Permit() {
    return permit;
  }),
}));

const server = testServer();
const vendor = { user: 'vendor1', city: 'california' };
const cityMeals = (city: string) => readStore().meals.filter((meal) => meal.city === city);

beforeEach(() => {
  vi.resetAllMocks();
  useTestEnv();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /meals', () => {
  it("returns the caller's city's menu when Permit allows read", async () => {
    const reply = await server.get<Meal[]>('/meals', { user: 'customer2', city: 'washington' });

    expect(reply.status).toBe(200);
    expect(reply.body.map((meal) => meal.id)).toEqual(['clam-chowder', 'salmon-dinner']);
    expect(permit.check).toHaveBeenCalledWith('customer2', 'read', {
      type: 'Meal',
      tenant: 'washington',
    });
  });

  it('answers 403 when Permit denies read in that city', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.get('/meals', { user: 'customer1', city: 'washington' });

    expect(reply).toMatchObject({
      status: 403,
      body: { message: 'You are not permitted to perform this action' },
    });
  });

  it('answers 502 and logs the failure when the PDP cannot be reached', async () => {
    permit.check.mockRejectedValue(pdpDown());

    const reply = await server.get('/meals');

    expect(reply).toMatchObject({
      status: 502,
      body: { message: 'Permit could not check read on Meal.' },
    });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it.each([
    ['no user', { user: '' }, 'user must be'],
    ['a user key with spaces', { user: 'two words' }, 'user must be'],
    ['an unknown city', { city: 'oregon' }, 'Unknown city: oregon'],
  ])('answers 400 for %s, without asking Permit', async (_case, caller, message) => {
    const reply = await server.get<{ message: string }>('/meals', caller);

    expect(reply.status).toBe(400);
    expect(reply.body.message).toContain(message);
    expect(permit.check).not.toHaveBeenCalled();
  });
});

describe('POST /meals', () => {
  it('creates the meal for the caller and registers it in Permit', async () => {
    const reply = await server.post<{ id: string }>(
      '/meals',
      { name: 'Calzone', price: 140 },
      vendor,
    );

    expect(reply.status).toBe(201);
    const { id } = reply.body;
    expect(permit.check).toHaveBeenCalledWith('vendor1', 'create', {
      type: 'Meal',
      tenant: 'california',
    });
    expect(permit.api.resourceInstances.create).toHaveBeenCalledWith({
      key: id,
      resource: 'Meal',
      tenant: 'california',
    });
    expect(cityMeals('california')[0]).toEqual({
      id,
      name: 'Calzone',
      price: 140,
      vendor: 'vendor1',
      city: 'california',
    });
  });

  it('accepts a price sent as a numeric string', async () => {
    const reply = await server.post<{ id: string }>(
      '/meals',
      { name: 'Tea', price: '3.5' },
      vendor,
    );

    expect(reply.status).toBe(201);
    expect(cityMeals('california')[0]?.price).toBe(3.5);
  });

  it('answers 403 and writes nothing when Permit denies create', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.post('/meals', { name: 'Calzone', price: 140 });

    expect(reply.status).toBe(403);
    expect(permit.api.resourceInstances.create).not.toHaveBeenCalled();
    expect(cityMeals('california')).toHaveLength(4);
  });

  it.each([
    ['a short name', { name: 'ab', price: 10 }, 'name must be'],
    ['a zero price', { name: 'Calzone', price: 0 }, 'price must be'],
    ['a price that is not a number', { name: 'Calzone', price: 'ten' }, 'price must be'],
    ['a body that is not an object', ['Calzone'], 'Send a JSON object.'],
  ])('answers 400 for %s', async (_case, body, message) => {
    const reply = await server.post<{ message: string }>('/meals', body, vendor);

    expect(reply.status).toBe(400);
    expect(reply.body.message).toContain(message);
    expect(permit.check).not.toHaveBeenCalled();
  });

  it('answers 502 and keeps the menu as it was when Permit cannot register the meal', async () => {
    permit.api.resourceInstances.create.mockRejectedValue(apiError(500));

    const reply = await server.post('/meals', { name: 'Calzone', price: 140 }, vendor);

    expect(reply.status).toBe(502);
    expect(reply.body).toMatchObject({ message: expect.stringContaining('Permit answered 500') });
    expect(cityMeals('california')).toHaveLength(4);
  });

  it("keeps ten meals per city and removes the dropped meal's instance from Permit", async () => {
    for (let n = 1; n <= 7; n++) {
      await server.post('/meals', { name: `Meal ${n}`, price: n }, vendor);
    }

    const meals = cityMeals('california');
    expect(meals).toHaveLength(10);
    expect(meals.map((meal) => meal.id)).not.toContain('miso-soup');
    expect(permit.api.resourceInstances.delete).toHaveBeenCalledWith('Meal:miso-soup');
    expect(cityMeals('washington')).toHaveLength(2);
  });

  it('logs, but does not fail on, a dropped meal Permit cannot delete', async () => {
    permit.api.resourceInstances.delete.mockRejectedValue(apiError(500));
    for (let n = 1; n <= 7; n++) {
      expect((await server.post('/meals', { name: `Meal ${n}`, price: n }, vendor)).status).toBe(
        201,
      );
    }

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Permit could not delete Meal:miso-soup'),
    );
  });
});

describe('DELETE /meal/:id', () => {
  it('removes the meal from the menu and from Permit', async () => {
    const reply = await server.delete('/meal/miso-soup', undefined, vendor);

    expect(reply).toEqual({ status: 200, body: { message: 'Miso soup removed from the menu' } });
    expect(permit.check).toHaveBeenCalledWith('vendor1', 'delete', {
      type: 'Meal',
      key: 'miso-soup',
      tenant: 'california',
    });
    expect(permit.api.resourceInstances.delete).toHaveBeenCalledWith('Meal:miso-soup');
    expect(cityMeals('california').map((meal) => meal.id)).not.toContain('miso-soup');
  });

  it('removes the meal when Permit never had it (404)', async () => {
    permit.api.resourceInstances.delete.mockRejectedValue(apiError(404));

    const reply = await server.delete('/meal/miso-soup', undefined, vendor);

    expect(reply.status).toBe(200);
    expect(cityMeals('california').map((meal) => meal.id)).not.toContain('miso-soup');
  });

  it('answers 403 and keeps the meal when Permit denies delete', async () => {
    permit.decide.mockReturnValue(false);

    const reply = await server.delete('/meal/miso-soup', undefined, { user: 'customer1' });

    expect(reply.status).toBe(403);
    expect(permit.api.resourceInstances.delete).not.toHaveBeenCalled();
    expect(cityMeals('california').map((meal) => meal.id)).toContain('miso-soup');
  });

  it("answers 404 for a meal on another city's menu", async () => {
    const reply = await server.delete('/meal/clam-chowder', undefined, vendor);

    expect(reply).toMatchObject({
      status: 404,
      body: { message: 'Meal clam-chowder not found in california' },
    });
    expect(permit.check).not.toHaveBeenCalled();
  });

  it('answers 502 and keeps the meal when Permit fails to delete it', async () => {
    permit.api.resourceInstances.delete.mockRejectedValue(apiError(503));

    const reply = await server.delete('/meal/miso-soup', undefined, vendor);

    expect(reply.status).toBe(502);
    expect(cityMeals('california').map((meal) => meal.id)).toContain('miso-soup');
  });
});
