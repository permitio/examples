// S2's two writes as the page sends them. POST goes through the shared client; DELETE has no helper there, so grants.ts
// sends it itself, and these tests pin that it speaks the same way: the persona header, a JSON body, and the server's own
// words in an ApiError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setPersona } from '../src/web/api';
import { grantRole, revokeRole } from '../src/web/pages/s2/grants';

const GRANT = { user: 'merry', role: 'location_operator', resource: 'location:LOC-BYWATER' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grantRole', () => {
  it('POSTs the member, role and resource as JSON to /api/s2/grants, as the current persona', async () => {
    const fetchMock = stubFetch(() => jsonResponse(201, { ms: 640 }));
    setPersona('sam');
    await expect(grantRole(GRANT)).resolves.toEqual({ ms: 640 });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/s2/grants');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-persona': 'sam' } });
    expect(JSON.parse(String(init?.body))).toEqual(GRANT);
  });

  it('resolves a repeat that Permit already had, answered 201 with ms 0, as a success', async () => {
    stubFetch(() => jsonResponse(201, { ms: 0 }));
    await expect(grantRole(GRANT)).resolves.toEqual({ ms: 0 });
  });
});

describe('revokeRole', () => {
  it('DELETEs /api/s2/grants with the member, role and resource as a JSON body, as the current persona', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { ms: 580 }));
    setPersona('sam');
    await expect(revokeRole(GRANT)).resolves.toEqual({ ms: 580 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/s2/grants');
    expect(init).toMatchObject({ method: 'DELETE', headers: { 'content-type': 'application/json', 'x-demo-persona': 'sam' } });
    expect(JSON.parse(String(init?.body))).toEqual(GRANT);
  });

  it('resolves a repeat that Permit already had, answered with ms 0, as a success: the page flips the toggle on it', async () => {
    stubFetch(() => jsonResponse(200, { ms: 0 }));
    await expect(revokeRole(GRANT)).resolves.toEqual({ ms: 0 });
  });

  it('is not a background refresh: it never says x-demo-source, so its checks show in the decision panel', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { ms: 0 }));
    await revokeRole(GRANT);
    expect(headersOf(fetchMock.mock.calls[0]?.[1])['x-demo-source']).toBeUndefined();
  });

  it("throws an ApiError with the status, Permit's own words and the decision when the portal refuses", async () => {
    stubFetch(() => jsonResponse(403, { error: 'Permit denied grant_location_operator on location:LOC-MICHEL.', decision: 'deny' }));
    setPersona('frodo');
    const error = await revokeRole({ ...GRANT, resource: 'location:LOC-MICHEL' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: 'Permit denied grant_location_operator on location:LOC-MICHEL.', decision: 'deny' });
  });

  it('surfaces a 424 text unchanged, with no decision', async () => {
    const text = 'The PDP did not confirm this change within 5 seconds.';
    stubFetch(() => jsonResponse(424, { error: text }));
    const error = await revokeRole(GRANT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 424, message: text });
    expect((error as ApiError).decision).toBeUndefined();
  });

  it('names the status when the answer has no error text', async () => {
    stubFetch(() => new Response('<h1>Bad gateway</h1>', { status: 502 }));
    const error = await revokeRole(GRANT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: 'Request failed (502)' });
  });
});

describe('the DELETE helper and the shared client agree on a refusal', () => {
  it('turns the same 403 into the same ApiError', async () => {
    const body = { error: 'Permit denied grant_shipper on ean:EAN-1002.', decision: 'deny' };
    stubFetch(() => jsonResponse(403, body));
    const viaPost = await grantRole({ ...GRANT, role: 'shipper', resource: 'ean:EAN-1002' }).catch((e: unknown) => e);
    const viaDelete = await revokeRole({ ...GRANT, role: 'shipper', resource: 'ean:EAN-1002' }).catch((e: unknown) => e);
    expect(viaDelete).toBeInstanceOf(ApiError);
    expect({ status: (viaDelete as ApiError).status, message: (viaDelete as ApiError).message, decision: (viaDelete as ApiError).decision }).toEqual({
      status: (viaPost as ApiError).status, message: (viaPost as ApiError).message, decision: (viaPost as ApiError).decision,
    });
  });
});
