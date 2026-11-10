import { describe, expect, it, vi } from 'vitest';
import { buildRequest, environmentScope, PermitRestClient } from '@/setup/permit-rest';

const API_URL = 'http://permit.test';
const KEY = 'test-only-key-77';

function fakeFetch(...responses: Array<Response | Error>) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetchImpl.mockRejectedValueOnce(response);
    else fetchImpl.mockResolvedValueOnce(response);
  }
  return fetchImpl;
}

describe('buildRequest', () => {
  it('puts the API key in the Authorization header and the body as JSON', () => {
    const { url, init } = buildRequest(API_URL, KEY, {
      method: 'POST',
      path: '/v2/facts/p/e/tenants',
      body: { key: 'alice', name: 'Alice' },
    });
    expect(url).toBe('http://permit.test/v2/facts/p/e/tenants');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe('{"key":"alice","name":"Alice"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no body or Content-Type for a GET', () => {
    const { init } = buildRequest(API_URL, KEY, { method: 'GET', path: '/v2/api-key/scope' });
    expect(init).not.toHaveProperty('body');
    expect(init.headers).not.toHaveProperty('Content-Type');
  });
});

describe('PermitRestClient', () => {
  it('answers the status and the parsed body', async () => {
    const client = new PermitRestClient(API_URL, KEY, fakeFetch(Response.json({ id: 'x' })));
    expect(await client.send({ method: 'GET', path: '/a' })).toEqual({
      status: 200,
      body: { id: 'x' },
    });
  });

  it('accepts the statuses the request lists, such as 409 for "already exists"', async () => {
    const client = new PermitRestClient(
      API_URL,
      KEY,
      fakeFetch(new Response('{"detail":"exists"}', { status: 409 })),
    );
    const response = await client.send({ method: 'POST', path: '/a', body: {}, accept: [409] });
    expect(response.status).toBe(409);
  });

  it('throws with the method, path, status and body for any other failure', async () => {
    const client = new PermitRestClient(
      API_URL,
      KEY,
      fakeFetch(new Response('{"detail":"bad role"}', { status: 422 })),
    );
    await expect(client.send({ method: 'POST', path: '/v2/x', body: {} })).rejects.toThrow(
      'POST /v2/x failed with HTTP 422: {"detail":"bad role"}',
    );
  });

  it('says to check PERMIT_API_URL when Permit cannot be reached, without the key', async () => {
    const client = new PermitRestClient(API_URL, KEY, fakeFetch(new TypeError('fetch failed')));
    const error = await client.send({ method: 'GET', path: '/a' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Check PERMIT_API_URL');
    expect((error as Error).message).not.toContain(KEY);
  });

  it('sends a list of requests in order', async () => {
    const fetchImpl = fakeFetch(new Response(null, { status: 204 }), Response.json({}));
    const client = new PermitRestClient(API_URL, KEY, fetchImpl);
    await client.sendAll([
      { method: 'POST', path: '/first' },
      { method: 'PUT', path: '/second' },
    ]);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://permit.test/first',
      'http://permit.test/second',
    ]);
  });
});

describe('environmentScope', () => {
  it("answers the key's project and environment", async () => {
    const client = new PermitRestClient(
      API_URL,
      KEY,
      fakeFetch(Response.json({ organization_id: 'o', project_id: 'p', environment_id: 'e' })),
    );
    expect(await environmentScope(client)).toEqual({ project: 'p', environment: 'e' });
  });

  it('refuses a project-level key', async () => {
    const client = new PermitRestClient(
      API_URL,
      KEY,
      fakeFetch(Response.json({ organization_id: 'o', project_id: 'p', environment_id: null })),
    );
    await expect(environmentScope(client)).rejects.toThrow('not an environment-level key');
  });
});
