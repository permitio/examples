import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPath, callApi } from '#lib/client';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (status: number, body: string) =>
  fetchMock.mockResolvedValue(new Response(body, { status }));

describe('callApi', () => {
  it('sends the persona in X-User and returns the JSON body', async () => {
    answer(200, '[{"key":"harry@potter.io"}]');

    const outcome = await callApi('/api/user', 'albus@pink.mobile');

    expect(outcome).toEqual({ ok: true, data: [{ key: 'harry@potter.io' }] });
    expect(fetchMock).toHaveBeenCalledWith('/api/user', {
      method: 'GET',
      headers: { 'X-User': 'albus@pink.mobile' },
    });
  });

  it("returns the route's error for a deny", async () => {
    answer(403, '{"error":"User harry@potter.io is not allowed to list users"}');

    const outcome = await callApi('/api/user', 'harry@potter.io');

    expect(outcome).toEqual({
      ok: false,
      error: 'User harry@potter.io is not allowed to list users',
    });
  });

  it('falls back to the status when an error body is not JSON', async () => {
    answer(500, '<!DOCTYPE html><title>500</title>');

    expect(await callApi('/api/user', 'albus@pink.mobile', 'POST')).toEqual({
      ok: false,
      error: 'The request failed with 500',
    });
  });

  it('fails a successful answer that is not JSON', async () => {
    answer(200, 'not json');

    expect(await callApi('/api/user', 'albus@pink.mobile')).toEqual({
      ok: false,
      error: '/api/user did not answer with JSON',
    });
  });

  it('returns the network error instead of throwing it', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await callApi('/api/user', 'albus@pink.mobile')).toEqual({
      ok: false,
      error: 'Failed to fetch',
    });
  });
});

describe('apiPath', () => {
  it('encodes each segment', () => {
    expect(apiPath('plan', 'harry@potter.io', 'VIP')).toBe('/api/plan/harry%40potter.io/VIP');
    expect(apiPath('account', 'a/b@c.d')).toBe('/api/account/a%2Fb%40c.d');
  });
});
